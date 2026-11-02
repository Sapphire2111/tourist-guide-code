import { AsyncLocalStorage } from "node:async_hooks";
import type { JobContext } from "@tg/queue-contract";

// JobContext, systemContext, isJobContext — в @tg/queue-contract (общие с продюсерами); здесь — хранение
// контекста текущей задачи в рантайме worker.

const storage = new AsyncLocalStorage<JobContext>();

/** Выполняет fn в контексте задачи; слой БД (T1-11) прочитает его через currentJobContext(). */
export function runInJobContext<T>(context: JobContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Контекст текущей задачи или undefined вне обработчика. */
export function currentJobContext(): JobContext | undefined {
  return storage.getStore();
}
