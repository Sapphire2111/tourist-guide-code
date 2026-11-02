import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createErrorTracker,
  installProcessErrorHandlers,
  JsonLogger,
  loadEnvOrExit,
} from "@tg/server-config";
import { AppModule } from "./app.module.js";
import { configureApp } from "./bootstrap/configure-app.js";
import { ApiRootModule } from "./bootstrap/error-tracker.module.js";
import { apiEnvSchema, trustProxyHops } from "./config.js";
import { checkDbRole, DATABASE, readDbRoleStatus, type Db } from "./db/index.js";

const env = loadEnvOrExit("api", apiEnvSchema);
// T1-18: structured JSON-логи без ПДн; трекер ошибок — в лог, при SENTRY_DSN ещё и в Sentry.
const logger = new JsonLogger({ service: "api", level: env.LOG_LEVEL });
const errorTracker = createErrorTracker({
  service: "api",
  environment: env.APP_ENV,
  dsn: env.SENTRY_DSN,
  logger,
});
installProcessErrorHandlers(errorTracker);
// ApiRootModule: AppModule + flush трекера в shutdown-хуке.
const root = ApiRootModule.forRoot(AppModule.forRoot(env), errorTracker);
const app = configureApp(await NestFactory.create(root, { logger }), {
  appEnv: env.APP_ENV,
  corsOrigins: env.CORS_ORIGINS,
  metricsToken: env.METRICS_TOKEN,
  errorTracker,
  trustProxyHops: trustProxyHops(env),
});
app.enableShutdownHooks(); // SIGTERM/SIGINT → onModuleDestroy/onApplicationShutdown (пул БД), затем выход
// T1-11: роль БД в обход RLS (SUPERUSER/BYPASSRLS) — в staging/prod отказ запуска, в local — предупреждение.
// Одно соединение до listen, не дольше 5 с; БД недоступна — предупреждение и старт, как раньше (src/db/role-check.ts).
try {
  await checkDbRole({
    appEnv: env.APP_ENV,
    read: () => readDbRoleStatus(app.get<Db>(DATABASE)),
    logger: new Logger("Database"),
  });
} catch (err) {
  console.error(`api не запущен: ${(err as Error).message}`);
  await app.close();
  process.exit(1);
}
await app.listen(env.PORT);
