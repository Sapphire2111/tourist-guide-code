import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { SESSION_SECURITY } from "../common/http/index.js";

/**
 * Версия контракта. Несовместимое изменение API помечается меткой PR `api-breaking`
 * (см. README, «API-контракт»); major здесь повышается вместе с такой меткой.
 */
export const API_VERSION = "0.1.0";

/** Code-first OpenAPI-документ из контроллеров и DTO приложения. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Гід туриста API")
    .setDescription(
      "Ошибки — единый конверт ErrorEnvelope; correlation id — заголовок X-Request-Id. " +
        "Даты — ISO 8601 UTC, деньги — целые минимальные единицы + валюта ISO 4217.",
    )
    .setVersion(API_VERSION)
    // addSecurity, не addBearerAuth: тот подставляет bearerFormat "JWT", а токен сессии непрозрачный (ADR-0009).
    .addSecurity(SESSION_SECURITY, {
      type: "http",
      scheme: "bearer",
      description:
        "Непрозрачный токен сессии (`Authorization: Bearer tgs_…`, не JWT), выдаётся при входе; хранить только в " +
        "памяти/хранилище клиента.",
    })
    .build();
  return SwaggerModule.createDocument(app, config);
}
