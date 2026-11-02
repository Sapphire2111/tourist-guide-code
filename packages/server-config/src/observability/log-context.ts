import { AsyncLocalStorage } from "node:async_hooks";

/** Поля, которые JSON-логгер добавляет к каждой записи в пределах запроса/задачи. */
export interface LogContext {
  correlationId?: string;
  regionId?: string | null;
  jobId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Выполняет fn с контекстом логов (наследует поля внешнего контекста). */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Дополняет текущий контекст (например, regionId после разрешения tenant). Вне контекста — no-op. */
export function setLogContext(fields: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

/** Контекст текущего запроса/задачи или undefined. */
export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}
