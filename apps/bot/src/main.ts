import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { installProcessErrorHandlers, JsonLogger, loadEnvOrExit, type ErrorTracker } from "@tg/server-config";
import { AppModule } from "./app.module.js";
import { botEnvSchema, listenPort } from "./config.js";
import { ERROR_TRACKER } from "./tokens.js";

const env = loadEnvOrExit("bot", botEnvSchema);
// T1-18: structured JSON-логи без ПДн (initData, телефоны, токен бота маскируются).
const app = await NestFactory.create(AppModule.forRoot(env), {
  logger: new JsonLogger({ service: "bot", level: env.LOG_LEVEL }),
});
installProcessErrorHandlers(app.get<ErrorTracker>(ERROR_TRACKER));
app.enableShutdownHooks(); // SIGTERM → закрытие воркера и очереди (OutboxShutdown)
await app.listen(listenPort(env));
