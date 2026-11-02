/**
 * Остановка рантайма с ограничением по времени. worker.close() ждёт активные задачи и ответа Redis —
 * при недоступном Redis это может длиться бесконечно, а compose/Render убьют процесс по SIGKILL.
 * Каждый шаг ограничен таймаутом; по истечении соединения разрываются принудительно (disconnect).
 * Прерванная задача останется active, станет stalled и выполнится повторно — доставка «как минимум один раз».
 */
import type { JobLogger } from "./handlers.js";

/** Минимум от Worker/Queue из bullmq, нужный для остановки (удобно мокать). */
export interface Closable {
  readonly name: string;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CloseTargets {
  workers: readonly Closable[];
  queues: readonly Closable[];
  /** Незавершённые фоновые записи (dead-letter из события «failed»). */
  pending: () => readonly Promise<unknown>[];
  /** Таймаут каждого шага, мс. */
  timeoutMs: number;
  logger: JobLogger;
}

export const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

const TIMEOUT = Symbol("timeout");

/** Ждёт промис не дольше ms; возвращает TIMEOUT, если не дождались. Таймер не держит процесс. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeGroup(kind: string, items: readonly Closable[], timeoutMs: number, logger: JobLogger) {
  const graceful = Promise.allSettled(items.map((i) => i.close()));
  const result = await within(graceful, timeoutMs);
  if (result !== TIMEOUT) {
    result.forEach((r, i) => {
      if (r.status === "rejected") logger.error(`Закрытие (${kind} ${items[i]!.name}): ${String(r.reason)}`);
    });
    return;
  }
  logger.warn(`${kind}: штатное закрытие не уложилось в ${timeoutMs} мс — принудительный disconnect`);
  const forced = await within(Promise.allSettled(items.map((i) => i.disconnect())), timeoutMs);
  if (forced === TIMEOUT) logger.error(`${kind}: disconnect не завершился за ${timeoutMs} мс`);
}

/** Сначала воркеры (дожидаются активных задач), затем фоновые записи, затем очереди. */
export async function closeRuntime({
  workers,
  queues,
  pending,
  timeoutMs,
  logger,
}: CloseTargets): Promise<void> {
  await closeGroup("воркеры", workers, timeoutMs, logger);
  if ((await within(Promise.allSettled(pending()), timeoutMs)) === TIMEOUT) {
    logger.warn(`Записи в dead-letter не завершились за ${timeoutMs} мс`);
  }
  await closeGroup("очереди", queues, timeoutMs, logger);
}
