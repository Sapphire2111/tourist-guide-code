// eslint-disable-next-line tg/no-raw-sql -- только вызовы фиксированных функций БД (audit-pii-purger, analytics-writer, media-assets-store), без запросов к таблицам
import pg from "pg";
import type { AnalyticsWriter, AuditPiiPurger, MediaAssetStore } from "../queue/handlers.js";
import { analyticsWriter } from "./analytics-writer.js";
import { auditPiiPurger } from "./audit-pii-purger.js";
import { mediaAssetStore } from "./media-assets-store.js";

/** Доступ воркера к БД: только вызовы фиксированных функций БД поверх одного пула. */
export interface WorkerDb {
  purger: AuditPiiPurger;
  analytics: AnalyticsWriter;
  media: MediaAssetStore;
  close(): Promise<void>;
}

/** Пул соединений воркера (ленивый: соединение — при первой задаче) и операции поверх него. */
export function createWorkerDb(connectionString: string): WorkerDb {
  // max 4: очистка ПДн (раз в час) + запись событий (concurrency очереди analytics — 5, запрос короткий) + ресайз
  // фото (короткие вызовы функций между операциями с файлами).
  // keepAlive и таймаут подключения — как в api (Neon может «тихо» потерять сокет или долго просыпаться).
  const pool = new pg.Pool({ connectionString, max: 4, keepAlive: true, connectionTimeoutMillis: 10_000 });
  const logError = (err: Error) => console.error("PostgreSQL: обрыв соединения пула:", err.message);
  // Ошибка простаивающего соединения (рестарт БД) не должна ронять процесс: пул пересоздаст соединение.
  pool.on("error", logError);
  // Обрыв занятого соединения приходит на сам client — без слушателя процесс падает; запрос и так получит ошибку.
  pool.on("connect", (client) => client.on("error", logError));
  return {
    purger: auditPiiPurger(pool),
    analytics: analyticsWriter(pool),
    media: mediaAssetStore(pool),
    close: () => pool.end(),
  };
}
