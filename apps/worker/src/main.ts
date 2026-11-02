import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { installProcessErrorHandlers, JsonLogger, loadEnvOrExit } from "@tg/server-config";
import { AppModule } from "./app.module.js";
import { workerEnvSchema } from "./config.js";
import { QueueService } from "./queue/queue.service.js";

// Standalone-контекст без HTTP. createApplicationContext вызывает onApplicationBootstrap → QueueService
// запускает воркеры BullMQ; открытые соединения Redis удерживают процесс. SIGTERM/SIGINT → app.close()
// → onApplicationShutdown: воркеры дожидаются активных задач и закрываются, затем закрываются очереди.
const env = loadEnvOrExit("worker", workerEnvSchema);
// T1-18: structured JSON-логи без ПДн (correlationId/jobId/region_id задачи — из контекста processor).
const logger = new JsonLogger({ service: "worker", level: env.LOG_LEVEL });
const app = await NestFactory.createApplicationContext(AppModule.register(env), { logger });
app.enableShutdownHooks();
installProcessErrorHandlers(app.get(QueueService).errorTracker);
