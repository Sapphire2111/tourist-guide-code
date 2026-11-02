import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ApiOkResponse, ApiCreatedResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { ErrorCode } from "@tg/shared";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { currentDb, currentTenant, InjectDb, type Db } from "../../db/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { platformScope, RequirePermission, type RbacRequest } from "../rbac/index.js";
import { FEATURE_FLAG_KEYS, FINANCE_GATE_DECISIONS, type FeatureFlagKey } from "./catalog.js";
import {
  FeatureFlagsDto,
  FeatureFlagStateDto,
  FeatureFlagStatesDto,
  GateMarkDto,
  GateMarksDto,
  toFeatureFlagStateDto,
  toGateMarkDto,
} from "./feature-flags.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateGateMarkDto, FeatureFlagsQueryDto, SetFeatureFlagDto } from "./feature-flags.dto.js";
import { FeatureFlagError, FeatureFlagsService } from "./feature-flags.service.js";

/**
 * Эффективные значения флагов для фронтендов (скрытие выключенных модулей в UI, T1-22). Без аутентификации: флаги —
 * не секрет, а меню туриста нужно до входа. Регион — из запроса: это только чтение публичной настройки, не
 * tenant-данные; доступ к API модуля всё равно решает @RequireFeature по tenant-контексту на сервере.
 */
@ApiTags("feature-flags")
@Controller("feature-flags")
export class FeatureFlagsController {
  constructor(@Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService) {}

  @Get()
  @ApiOperation({ operationId: "getFeatureFlags", summary: "Эффективные значения фича-флагов" })
  @ApiOkResponse({ type: FeatureFlagsDto })
  // FORBIDDEN — выбранный в сессии регион без назначения в нём (tenant-контекст запроса, RequestAccess).
  @ApiErrors("VALIDATION_FAILED", "FORBIDDEN")
  async get(@Query() q: FeatureFlagsQueryDto): Promise<FeatureFlagsDto> {
    const regionId = q.regionId?.toLowerCase() ?? null;
    const values = await this.flags.effective(regionId);
    return { regionId, items: FEATURE_FLAG_KEYS.map((key) => ({ key, enabled: values[key] })) };
  }
}

type AdminRequest = RbacRequest & AuditableRequest;

/**
 * Управление флагами (T1-22): право feature_flag.manage на PLATFORM (roles-and-data §1.4 — только SUPERADMIN;
 * до бизнес-ролей блока 6 — техническая роль). Каждое изменение — запись в audit_logs в транзакции запроса.
 * finance.live в prod — дополнительно назначение SUPERADMIN и отметки ⚖-решений (FeatureFlagsService).
 */
@ApiTags("admin")
@Controller("admin/feature-flags")
@RequirePermission("feature_flag.manage", platformScope)
export class FeatureFlagsAdminController {
  constructor(
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
    @InjectDb() private readonly db: Db,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "listFeatureFlags",
    summary: "Флаги: значения по умолчанию и переопределения",
  })
  @ApiOkResponse({ type: FeatureFlagStatesDto })
  @ApiErrors("UNAUTHENTICATED", "FORBIDDEN")
  async list(): Promise<FeatureFlagStatesDto> {
    return { appEnv: this.flags.appEnv, items: (await this.flags.list()).map(toFeatureFlagStateDto) };
  }

  @Put(":key")
  @ApiOperation({ operationId: "setFeatureFlag", summary: "Переопределить флаг на окружение или регион" })
  @ApiParam({ name: "key", enum: FEATURE_FLAG_KEYS, enumName: "FeatureFlagKey" })
  @ApiOkResponse({ type: FeatureFlagStateDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE")
  async set(
    @Param("key") key: string,
    @Body() body: SetFeatureFlagDto,
    @Req() req: AdminRequest,
  ): Promise<FeatureFlagStateDto> {
    const trx = this.platformTrx();
    await this.flags
      .set(trx, {
        key,
        regionId: body.regionId ?? null,
        enabled: body.enabled,
        reason: body.reason ?? null,
        ...auditMeta(req),
      })
      .catch(rethrow);
    const state = (await this.flags.list()).find((s) => s.key === (key as FeatureFlagKey));
    if (!state) throw new ApiError("NOT_FOUND");
    return toFeatureFlagStateDto(state);
  }

  @Get("gate-marks")
  @ApiOperation({ operationId: "listFeatureFlagGateMarks", summary: "Отметки о закрытии ⚖-решений (D-81)" })
  @ApiOkResponse({ type: GateMarksDto })
  @ApiErrors("UNAUTHENTICATED", "FORBIDDEN")
  async gateMarks(): Promise<GateMarksDto> {
    return {
      required: [...FINANCE_GATE_DECISIONS],
      items: (await this.flags.gateMarks()).map(toGateMarkDto),
    };
  }

  @Post("gate-marks")
  @ApiOperation({ operationId: "createFeatureFlagGateMark", summary: "Отметить закрытие ⚖-решения (D-81)" })
  @ApiCreatedResponse({ type: GateMarkDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "CONFLICT", "UNPROCESSABLE")
  async markGate(@Body() body: CreateGateMarkDto, @Req() req: AdminRequest): Promise<GateMarkDto> {
    const mark = await this.flags
      .markGate(this.platformTrx(), {
        decision: body.decision,
        documentRef: body.documentRef,
        reason: body.reason ?? null,
        ...auditMeta(req),
      })
      .catch(rethrow);
    return toGateMarkDto(mark);
  }

  /**
   * Транзакция запроса в контексте PLATFORM. Назначение на PLATFORM при выбранном в сессии регионе даёт контекст
   * региона — в нём запись аудита другого региона невозможна, поэтому изменение флагов — только без выбранного региона.
   */
  private platformTrx(): Db {
    const tenant = currentTenant();
    if (tenant?.kind !== "platform" && tenant?.kind !== "system")
      throw new ApiError("FORBIDDEN", { details: { reason: "platform_context_required" } });
    return currentDb(this.db);
  }
}

/** Актор, назначение, correlation id и ПДн-часть запроса — для аудита изменения (auditFromRequest, T1-26). */
function auditMeta(req: AdminRequest) {
  const { roleAssignmentId, ...rest } = auditFromRequest(req);
  return { ...rest, actorAssignmentId: roleAssignmentId ?? null };
}

/** Код ответа на отказ; причина — в details.reason (тексты ошибок флагов — с админкой, блок 6). */
const ERROR_CODE = {
  unknown_flag: "NOT_FOUND",
  region_not_found: "UNPROCESSABLE",
  unknown_decision: "UNPROCESSABLE",
  finance_gate_role: "FORBIDDEN",
  finance_gate_open: "CONFLICT",
  finance_gate_mfa: "FORBIDDEN",
  already_marked: "CONFLICT",
} as const satisfies Record<FeatureFlagError["reason"], ErrorCode>;

/** FeatureFlagError → ответ API; прочее — как есть. */
function rethrow(e: unknown): never {
  if (!(e instanceof FeatureFlagError)) throw e;
  throw new ApiError(ERROR_CODE[e.reason], {
    details: e.missing.length ? { reason: e.reason, missingDecisions: [...e.missing] } : { reason: e.reason },
    cause: e,
  });
}
