import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { ApiError, ApiErrors, PublicCache } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { currentTenant } from "../../db/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { RequirePermission, scopeFromTenant, type RbacRequest } from "../rbac/index.js";
import {
  AdminScenarioDetailDto,
  AdminScenarioListDto,
  ScenarioDto,
  ScenarioListDto,
  UserPlanDto,
  UserPlanListDto,
} from "./planner.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AdminScenariosQueryDto,
  CreateUserPlanDto,
  PlannerRegionQueryDto,
  RegenerateUserPlanDto,
  ScenarioInputDto,
  ScenariosQueryDto,
  ScenarioStatusDto,
  UpdateUserPlanDto,
} from "./planner.dto.js";
import { PlannerService } from "./planner.service.js";

// Планировщик (блок 5, ADR-0020): сценарии и «Мій план» туриста — регион из запроса (как гид); админка — CRUD
// сценариев в tenant-контексте (scenario.manage). Туристские эндпоинты — за флагом module.host_requests.

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

const touristRegion: FeatureRegionResolver = ({ request }) => {
  const q = request.query?.regionId;
  if (typeof q === "string") return q;
  const b = request.body as { regionId?: unknown } | undefined;
  return typeof b?.regionId === "string" ? b.regionId : undefined;
};

type AuthedRequest = RbacRequest & AuditableRequest;

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}

@ApiTags("planner")
@Controller("scenarios")
@WithoutTenantContext()
@RequireFeature("module.host_requests", { region: touristRegion })
export class ScenariosController {
  constructor(@Inject(PlannerService) private readonly planner: PlannerService) {}

  @Get()
  @PublicCache(300)
  @ApiOperation({
    operationId: "listScenarios",
    summary:
      "Готовые сценарии региона (C09): опубликованные, текущего сезона (или season), фильтр по тегу и числу дней",
    description: "Без аутентификации. 404 — региона нет или он не активен.",
  })
  @ApiOkResponse({ type: ScenarioListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: ScenariosQueryDto): Promise<ScenarioListDto> {
    return this.planner.scenarios(q.regionId, { tag: q.tag, days: q.days, season: q.season });
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getScenario",
    summary: "Сценарий: план по дням, пункты с местами и альтернативами для «Замінити»",
    description:
      "Без аутентификации. Пункт с неопубликованным местом — place: null, available: false («Недоступно»); " +
      "альтернативы — только опубликованные места. 404 — нет или не опубликован.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ScenarioDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  get(@Param("id", uuid) id: string, @Query() q: PlannerRegionQueryDto): Promise<ScenarioDto> {
    return this.planner.scenario(q.regionId, id);
  }
}

@ApiTags("planner")
@Controller("me/plan")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.host_requests", { region: touristRegion })
export class UserPlansController {
  constructor(@Inject(PlannerService) private readonly planner: PlannerService) {}

  @Get()
  @ApiOperation({ operationId: "listMyPlans", summary: "«Збережені» планы пользователя в регионе (C09)" })
  @ApiOkResponse({ type: UserPlanListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: PlannerRegionQueryDto, @Req() req: RbacRequest): Promise<UserPlanListDto> {
    return this.planner.plans(q.regionId, userOf(req));
  }

  @Post()
  @ApiOperation({
    operationId: "createMyPlan",
    summary:
      "«Зберегти план»: копия опубликованного сценария или свой план (без scenarioId) с параметрами поездки",
    description:
      "Свой план при флаге planner.ai региона — через Claude (пункты из опубликованных мест, до ~40 с ожидания; " +
      "generation: ai), иначе или при сбое Claude — пустой план с вариантами на выбор (generation: fallback/null). " +
      "404 — сценария нет или он не опубликован; 409 errors.plan.limitReached — планов уже максимум; " +
      "422 errors.plan.placeUnavailable — basePlaceId не опубликованное место региона.",
  })
  @ApiCreatedResponse({ type: UserPlanDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE", "RATE_LIMITED")
  create(@Body() body: CreateUserPlanDto, @Req() req: RbacRequest): Promise<UserPlanDto> {
    return this.planner.createPlan(userOf(req), body);
  }

  @Post(":id/regenerate")
  @HttpCode(200)
  @ApiOperation({
    operationId: "regenerateMyPlan",
    summary: "«Інший варіант»: новий план через Claude з тими ж параметрами поїздки (флаг planner.ai)",
    description:
      "Свій план (без сценарію): пункти й назва замінюються новим планом, відмінним від поточного. Claude не впорався " +
      "(ліміт, помилка, перевірка) — план без змін, generation: fallback. 404 — плану немає або флаг planner.ai " +
      "вимкнено; 422 errors.plan.notCustom — план зі сценарію.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: UserPlanDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "UNPROCESSABLE", "RATE_LIMITED")
  regenerate(
    @Param("id", uuid) id: string,
    @Body() body: RegenerateUserPlanDto,
    @Req() req: RbacRequest,
  ): Promise<UserPlanDto> {
    return this.planner.regeneratePlan(userOf(req), id, body);
  }

  @Get(":id")
  @ApiOperation({ operationId: "getMyPlan", summary: "Сохранённый план по дням" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: UserPlanDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  get(
    @Param("id", uuid) id: string,
    @Query() q: PlannerRegionQueryDto,
    @Req() req: RbacRequest,
  ): Promise<UserPlanDto> {
    return this.planner.plan(q.regionId, userOf(req), id);
  }

  @Patch(":id")
  @ApiOperation({
    operationId: "updateMyPlan",
    summary:
      "Правка плана: параметры поездки, дата, галочка варианта (addItem), «Замінити» альтернативой, удалить пункт",
    description:
      "404 errors.plan.itemNotFound — пункта нет; 422 errors.plan.notAlternative — место не из альтернатив пункта " +
      "или не опубликовано (прежнее место становится альтернативой — можно вернуть); 422 errors.plan.placeUnavailable " +
      "— место addItem/basePlaceId не опубликовано; 422 errors.plan.dayOutOfRange — день больше trip.days; " +
      "409 errors.plan.alreadyInPlan — место уже в этом дне. Меньше days — пункты лишних дней убираются.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: UserPlanDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE", "RATE_LIMITED")
  update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateUserPlanDto,
    @Req() req: RbacRequest,
  ): Promise<UserPlanDto> {
    return this.planner.updatePlan(userOf(req), id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ operationId: "deleteMyPlan", summary: "Удалить сохранённый план" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Удалён" })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  async remove(
    @Param("id", uuid) id: string,
    @Query() q: PlannerRegionQueryDto,
    @Req() req: RbacRequest,
  ): Promise<void> {
    await this.planner.deletePlan(q.regionId, userOf(req), id);
  }
}

/** Сценарии региона в админке (scenario.manage): список, создание, полная правка, публикация. */
@ApiTags("admin")
@Controller("admin/scenarios")
@RequirePermission("scenario.manage", scopeFromTenant)
export class AdminScenariosController {
  constructor(@Inject(PlannerService) private readonly planner: PlannerService) {}

  @Get()
  @ApiOperation({ operationId: "listAdminScenarios", summary: "Сценарии региона (все статусы)" })
  @ApiOkResponse({ type: AdminScenarioListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  list(@Query() q: AdminScenariosQueryDto): Promise<AdminScenarioListDto> {
    return this.planner.adminList({ status: q.status, season: q.season, tag: q.tag });
  }

  @Post()
  @ApiOperation({
    operationId: "createAdminScenario",
    summary: "Новый сценарий (draft) с пунктами",
    description:
      "422 unknown_place — место не из региона; 409 errors.catalog.codeTaken; 403 region_context_required — " +
      "SUPERADMIN без выбранного региона.",
  })
  @ApiCreatedResponse({ type: AdminScenarioDetailDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "CONFLICT", "UNPROCESSABLE")
  create(@Body() body: ScenarioInputDto, @Req() req: AuthedRequest): Promise<AdminScenarioDetailDto> {
    return this.planner.adminCreate(regionOfRequest(), body, auditFromRequest(req));
  }

  @Get(":id")
  @ApiOperation({ operationId: "getAdminScenario", summary: "Сценарий с пунктами" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminScenarioDetailDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  get(@Param("id", uuid) id: string): Promise<AdminScenarioDetailDto> {
    return this.planner.adminGet(id);
  }

  @Put(":id")
  @ApiOperation({
    operationId: "updateAdminScenario",
    summary: "Заменить сценарий и его пункты (version + 1)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminScenarioDetailDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE")
  update(
    @Param("id", uuid) id: string,
    @Body() body: ScenarioInputDto,
    @Req() req: AuthedRequest,
  ): Promise<AdminScenarioDetailDto> {
    return this.planner.adminUpdate(id, body, auditFromRequest(req));
  }

  @Patch(":id/status")
  @ApiOperation({
    operationId: "setAdminScenarioStatus",
    summary: "Опубликовать / снять в черновик / в архив",
    description: "422 errors.scenario.notPublishable — нет ни одного опубликованного места.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminScenarioDetailDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE")
  setStatus(
    @Param("id", uuid) id: string,
    @Body() body: ScenarioStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<AdminScenarioDetailDto> {
    return this.planner.adminSetStatus(id, body.status, auditFromRequest(req));
  }
}

/** Регион запроса: сценарий принадлежит региону (PLATFORM без выбранного региона — 403). */
function regionOfRequest(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}
