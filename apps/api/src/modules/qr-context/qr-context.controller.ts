import { Controller, Get, Header, Inject, Param, Query, Req } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import { QrContextDto, toQrContextDto } from "./qr-context.dto.js";
import { QrContextService } from "./qr-context.service.js";
import { QR_CODE_MAX_LENGTH, QR_CODE_MIN_LENGTH } from "./start-param.js";

/** Лимит на IP × эндпоинт без сессии (на пользователя — с сессией): один гость сканирует QR редко. */
export const QR_CONTEXT_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;

/**
 * QR-контекст входа (блок 2, S-01; ADR-0016). Публичный: Mini App вызывает его сразу после запуска — по ссылке
 * startapp (GET /context/{start_param}) или без неё (GET /context, регион по умолчанию, без скана); сессия
 * необязательна (есть — скан привязывается к пользователю).
 * @WithoutTenantContext: регион запроса выводится на сервере (из QR-точки или регион по умолчанию), а не из назначений
 * принципала (у туриста их нет); сервис сам работает в withTenant(SYSTEM), как аудит.
 */
@ApiTags("context")
@WithoutTenantContext()
@Controller("context")
export class QrContextController {
  constructor(@Inject(QrContextService) private readonly service: QrContextService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @RateLimit(QR_CONTEXT_RATE_LIMIT)
  @ApiOperation({
    operationId: "getDefaultEntryContext",
    summary: "Контекст входа без QR — регион по умолчанию",
    description:
      "Обычное открытие Mini App без start_param. Без аутентификации; с Bearer-сессией контекст привязывается к " +
      "пользователю. Всегда 200, status default; region null — в платформе нет активного региона. Это не скан: " +
      "QRScanEvent, AttributionTouch и qr_scanned не пишутся; при регионе — EntryContext (default, source direct). " +
      `Rate limit ${QR_CONTEXT_RATE_LIMIT.limit}/мин. Ответ — Cache-Control: no-store; клиент вызывает эндпоинт ` +
      "один раз за открытие.",
  })
  @ApiQuery({
    name: "anonymousId",
    required: false,
    type: String,
    format: "uuid",
    description: "Анонимный id устройства (uuid) из прошлого ответа; не uuid — игнорируется, выдаётся новый",
  })
  @ApiOkResponse({ type: QrContextDto })
  @ApiErrors("RATE_LIMITED")
  async getDefault(
    @Query("anonymousId") anonymousId: unknown,
    @Req() req: RbacRequest,
  ): Promise<QrContextDto> {
    return toQrContextDto(
      await this.service.resolveDefault({
        userId: req.principal?.userId,
        anonymousId: typeof anonymousId === "string" ? anonymousId : undefined,
      }),
    );
  }

  @Get(":start_param")
  // Каждый вызов пишет скан и касание: ответ не должен браться из кеша браузера/прокси (и не должен кешироваться
  // чужой контекст с anonymousId).
  @Header("Cache-Control", "no-store")
  @RateLimit(QR_CONTEXT_RATE_LIMIT)
  @ApiOperation({
    operationId: "getEntryContext",
    summary: "Контекст входа по start_param QR (регион, точка, «Про заклад»)",
    description:
      "Без аутентификации; с Bearer-сессией скан привязывается к пользователю. Всегда 200: неизвестный, " +
      "деактивированный или не прошедший проверку формата параметр — нейтральный контекст региона (status ≠ ok). " +
      "Каждый вызов пишет QRScanEvent, AttributionTouch, EntryContext (если есть регион) и событие qr_scanned. " +
      `Rate limit ${QR_CONTEXT_RATE_LIMIT.limit}/мин. Ответ — Cache-Control: no-store; клиент вызывает эндпоинт ` +
      "один раз за открытие Mini App (повтор — лишний скан и касание). 400 — только битое percent-encoding пути " +
      "(запрос не доходит до обработчика).",
  })
  @ApiParam({
    name: "start_param",
    description:
      `Непрозрачный код QR-точки из startapp: [A-Za-z0-9_-]{${QR_CODE_MIN_LENGTH},${QR_CODE_MAX_LENGTH}}, ` +
      "не только цифры. Другое значение не ошибка — status invalid.",
  })
  @ApiQuery({
    name: "anonymousId",
    required: false,
    type: String,
    format: "uuid",
    description: "Анонимный id устройства (uuid) из прошлого ответа; не uuid — игнорируется, выдаётся новый",
  })
  @ApiOkResponse({ type: QrContextDto })
  @ApiErrors("RATE_LIMITED")
  async get(
    @Param("start_param") startParam: string,
    @Query("anonymousId") anonymousId: unknown,
    @Req() req: RbacRequest,
  ): Promise<QrContextDto> {
    return toQrContextDto(
      await this.service.resolve({
        startParam,
        userId: req.principal?.userId,
        anonymousId: typeof anonymousId === "string" ? anonymousId : undefined,
      }),
    );
  }
}
