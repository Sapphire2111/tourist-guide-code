import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { configureSharpForLowMemory, createStorage, type Storage, type StorageEnv } from "@tg/media";
import { DATABASE, type Db } from "../../db/index.js";
import { RbacModule } from "../rbac/index.js";
import { LocalStorageController } from "./local-storage.controller.js";
import { MediaController } from "./media.controller.js";
import { InlineMediaJobs, MEDIA_JOBS, QueueMediaJobs, type MediaProcessingMode } from "./media.jobs.js";
import { MediaRepository } from "./media.repository.js";
import { MEDIA_STORAGE, MediaService } from "./media.service.js";

export type MediaModuleOptions = {
  /** Переменные хранилища (STORAGE_*, S3_*); не заданы (генерация OpenAPI, тесты) — local с временным секретом. */
  storage?: Partial<StorageEnv>;
  /** Внешний адрес api — для ссылок local-драйвера (PUBLIC_API_URL). */
  apiBaseUrl: string;
  /** Ресайз фото: queue (нужен redisUrl) или inline. */
  processing?: MediaProcessingMode;
  redisUrl?: string;
  /** Готовое хранилище вместо сборки из env (тесты). */
  storageInstance?: Storage;
};

/**
 * Файлы и изображения (T1-20, ADR-0013): учёт в media_assets, загрузка по подписанным ссылкам, ресайз через очередь
 * или в процессе. При драйвере local подключает маршруты /storage/objects (приём и отдача по HMAC-подписи).
 */
@Module({})
export class MediaModule {
  static forRoot(options: MediaModuleOptions): DynamicModule {
    const env: StorageEnv = { STORAGE_DRIVER: "local", ...options.storage } as StorageEnv;
    const processing = options.processing ?? "inline";
    if (processing === "queue" && !options.redisUrl)
      throw new Error("MEDIA_PROCESSING=queue требует REDIS_URL");
    const driver = options.storageInstance?.driver.driver ?? env.STORAGE_DRIVER;
    return {
      module: MediaModule,
      imports: [RbacModule],
      controllers: [MediaController, ...(driver === "local" ? [LocalStorageController] : [])],
      providers: [
        MediaRepository,
        MediaService,
        {
          provide: MEDIA_STORAGE,
          useFactory: (): Storage => {
            const storage = options.storageInstance ?? createStorage(env, options.apiBaseUrl);
            const logger = new Logger("Media");
            logger.log(`Хранилище: ${storage.driver.driver}; ресайз: ${processing}`);
            if (storage.ephemeralSecret)
              logger.warn(
                "STORAGE_SIGNING_SECRET не задан: подпись ссылок local — случайный секрет процесса (ссылки не переживут рестарт)",
              );
            return storage;
          },
        },
        {
          provide: MEDIA_JOBS,
          inject: [DATABASE, MEDIA_STORAGE],
          useFactory: (db: Db, storage: Storage) => {
            if (processing === "queue") return QueueMediaJobs.open(options.redisUrl!);
            // Ресайз в процессе api: sharp в один поток без кеша (память free-инстанса).
            configureSharpForLowMemory();
            return new InlineMediaJobs(db, storage);
          },
        },
      ],
      exports: [MediaService],
    };
  }
}
