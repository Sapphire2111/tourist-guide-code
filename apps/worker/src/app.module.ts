import { Module, type DynamicModule } from "@nestjs/common";
import type { WorkerEnv } from "./config.js";
import {
  WORKER_DB_FACTORY,
  QUEUE_RUNTIME_FACTORY,
  QueueService,
  WORKER_ENV,
  defaultWorkerDbFactory,
  defaultQueueRuntimeFactory,
  type WorkerDbFactory,
  type QueueRuntimeFactory,
} from "./queue/queue.service.js";

@Module({})
export class AppModule {
  /** Модуль с проверенным env; фабрики рантайма и подключения к БД подменяют тесты. */
  static register(
    env: WorkerEnv,
    factory: QueueRuntimeFactory = defaultQueueRuntimeFactory,
    dbFactory: WorkerDbFactory = defaultWorkerDbFactory,
  ): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: QUEUE_RUNTIME_FACTORY, useValue: factory },
        { provide: WORKER_DB_FACTORY, useValue: dbFactory },
        QueueService,
      ],
    };
  }
}
