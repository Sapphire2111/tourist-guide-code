import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { ApiAcceptedResponse, ApiBody, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { ANALYTICS_BATCH_MAX, clientAnalyticsBatchSchema, type AnalyticsBatchAccepted } from "@tg/shared";
import { z } from "@tg/server-config";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { AnalyticsService } from "./analytics.service.js";

class AnalyticsBatchAcceptedDto implements AnalyticsBatchAccepted {
  @ApiProperty({ type: "integer", minimum: 1, maximum: ANALYTICS_BATCH_MAX, description: "Принято событий" })
  accepted!: number;
}

/** Схема тела для OpenAPI — из той же zod-схемы, что проверяет запрос (единый источник — @tg/shared). */
const batchBodySchema = z.toJSONSchema(clientAnalyticsBatchSchema, {
  target: "openapi-3.0",
  io: "input",
  unrepresentable: "any",
}) as Record<string, unknown>;

/**
 * Приём событий фронтенда (T1-25). Без аутентификации — каркас сессий T1-26 идёт параллельно: актор (псевдоним
 * пользователя) и регион будут браться из сессии/контекста входа (TODO в AnalyticsService). Rate limit — T1-24
 * (по IP/устройству; до него эндпоинт ограничен только размером пакета). Принятый риск тестового режима —
 * README api, «Аналитические события»; флаг ANALYTICS_CLIENT_EVENTS (в prod по умолчанию off → 404).
 * @WithoutTenantContext: события не пишутся от имени принципала (регион — из события, запись функцией БД от SYSTEM),
 * а сессия с регионом без назначения не должна получать 403 на аналитике. Principal.sessionId в события не кладётся:
 * sessionId события — сессия приложения от клиента, не id сессии входа.
 */
@ApiTags("analytics")
@WithoutTenantContext()
@Controller("analytics")
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Post("events")
  @HttpCode(202)
  @ApiOperation({
    operationId: "trackAnalyticsEvents",
    summary: "Пакет продуктовых событий фронтенда (ТЗ §15.1)",
    description:
      `1…${ANALYTICS_BATCH_MAX} событий; только client-события каталога, без ПДн в props. Пакет принимается ` +
      "целиком или отклоняется целиком (400 VALIDATION_FAILED с путями полей). Запись асинхронная, повтор " +
      "с тем же eventId не создаёт дубль (eventId — рекомендуется UUIDv7). regionId — существующий регион. " +
      "Приём выключен флагом окружения (по умолчанию в prod) — 404 NOT_FOUND.",
  })
  @ApiBody({ schema: batchBodySchema })
  @ApiAcceptedResponse({ type: AnalyticsBatchAcceptedDto, description: "События приняты к записи" })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND")
  // body: unknown — глобальный ValidationPipe (class-validator) пропускает его, проверяет zod-схема в сервисе.
  async track(@Body() body: unknown): Promise<AnalyticsBatchAccepted> {
    return { accepted: await this.analytics.acceptClientBatch(body) };
  }
}
