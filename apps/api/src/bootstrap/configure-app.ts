import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { CORRELATION_ID_HEADER } from "@tg/shared";
import { MetricsRegistry, type AppEnv, type ErrorTracker } from "@tg/server-config";
import {
  correlationIdMiddleware,
  createValidationPipe,
  ErrorEnvelopeFilter,
  httpMetricsMiddleware,
  metricsHandler,
  securityHeadersMiddleware,
} from "../common/http/index.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../modules/idempotency/index.js";
import { buildOpenApiDocument } from "./openapi-document.js";

/**
 * Общая настройка HTTP-приложения: correlation id, валидация DTO, единый конверт ошибок,
 * Swagger UI (local и staging, не в prod), CORS по списку `corsOrigins` (пустой или не задан — CORS выключен,
 * браузер блокирует чужие Origin; cookie не используются, поэтому без credentials).
 * Наблюдаемость (T1-18, ADR-0010): RED-метрики по маршрутам и GET /metrics (Prometheus) — в local/staging
 * открыто, с `metricsToken` — только по Bearer, в prod без токена эндпоинт не подключается; трекер ошибок
 * получает необработанные 500.
 * Безопасность (T1-24): заголовки (nosniff, запрет фреймов, Referrer-Policy, CSP, HSTS вне local); trust proxy —
 * `trustProxyHops` прокси перед api (Render — 1), чтобы `req.ip` для rate limit брался из X-Forwarded-For, а не был
 * адресом балансировщика; 0 — заголовок не доверяется (local: подделать IP нельзя).
 * APP_ENV — из проверенного env (@tg/server-config). Вызывается из main.ts и из тестов — поведение одинаковое.
 */
export function configureApp(
  app: INestApplication,
  opts: {
    appEnv: AppEnv;
    corsOrigins?: readonly string[];
    metrics?: MetricsRegistry;
    metricsToken?: string;
    errorTracker?: ErrorTracker;
    trustProxyHops?: number;
  },
): INestApplication {
  const metrics = opts.metrics ?? new MetricsRegistry();
  const express = app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): unknown };
  express.set("x-powered-by", false);
  express.set("trust proxy", opts.trustProxyHops ?? 0);
  app.use(securityHeadersMiddleware(opts.appEnv));
  app.use(correlationIdMiddleware);
  if (opts.appEnv !== "prod" || opts.metricsToken)
    app.use("/metrics", metricsHandler(metrics, opts.metricsToken));
  app.use(httpMetricsMiddleware(metrics));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ErrorEnvelopeFilter(opts.errorTracker));
  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    app.enableCors({
      origin: [...opts.corsOrigins],
      // Retry-After — у 409 IDEMPOTENCY_IN_PROGRESS, Idempotent-Replayed — у повтора по Idempotency-Key (T1-14).
      exposedHeaders: [CORRELATION_ID_HEADER, "Retry-After", IDEMPOTENT_REPLAYED_HEADER],
      maxAge: 600,
    });
  }
  if (opts.appEnv === "local" || opts.appEnv === "staging") {
    SwaggerModule.setup("docs", app, () => buildOpenApiDocument(app), { jsonDocumentUrl: "openapi.json" });
  }
  return app;
}
