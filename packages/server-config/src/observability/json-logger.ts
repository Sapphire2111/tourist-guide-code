import { currentLogContext } from "./log-context.js";
import { redact, redactString } from "./redact.js";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

export interface JsonLoggerOptions {
  service: string;
  level?: LogLevel;
  /** Куда писать строку JSON (по умолчанию stdout; тесты подменяют). */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Structured JSON-логгер (одна строка JSON на запись): time, level, service, context, msg,
 * correlationId / region_id / jobId из контекста (log-context), err/stack. Всё проходит через redact().
 * Структурно совместим с LoggerService NestJS (log/error/warn/debug/verbose/fatal): подключается через
 * `NestFactory.create(..., { logger })`, и тогда `new Logger("X")` пишет сюда.
 */
export class JsonLogger {
  private readonly service: string;
  private readonly rank: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(opts: JsonLoggerOptions) {
    this.service = opts.service;
    this.rank = RANK[opts.level ?? "info"];
    this.write = opts.write ?? ((line) => process.stdout.write(line + "\n"));
    this.now = opts.now ?? (() => new Date());
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit("info", message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit("error", message, rest, true);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit("warn", message, rest, true);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit("trace", message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit("fatal", message, rest, true);
  }

  /**
   * Nest передаёт последним аргументом имя контекста (строку), для error/warn перед ним — stack.
   * Объект-сообщение раскладывается в поля записи.
   */
  private emit(level: LogLevel, message: unknown, rest: unknown[], withStack = false): void {
    if (RANK[level] > this.rank) return;
    const args = [...rest];
    const context = args.length > 0 && typeof args.at(-1) === "string" ? (args.pop() as string) : undefined;
    const entry: Record<string, unknown> = {};
    if (message instanceof Error) {
      entry.msg = redactString(message.message);
      entry.err = redact(message);
    } else if (typeof message === "object" && message !== null) {
      const fields = redact(message);
      if (typeof fields === "object" && fields !== null) Object.assign(entry, fields);
    } else {
      entry.msg = redactString(String(message));
    }
    // Служебные поля — после полей сообщения: объект-сообщение не может их подменить.
    entry.time = this.now().toISOString();
    entry.level = level;
    entry.service = this.service;
    // context тоже маскируется: Nest без контекста передаёт сюда stack.
    if (context) entry.context = redactString(context);
    const ctx = currentLogContext();
    if (ctx?.correlationId) entry.correlationId = ctx.correlationId;
    if (ctx && ctx.regionId !== undefined) entry.region_id = ctx.regionId;
    if (ctx?.jobId) entry.jobId = ctx.jobId;
    const extra: unknown[] = [];
    for (const a of args) {
      if (withStack && typeof a === "string" && entry.stack === undefined) entry.stack = redactString(a);
      else if (a !== undefined) extra.push(redact(a));
    }
    if (extra.length > 0) entry.extra = extra;
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({
        time: entry.time,
        level,
        service: this.service,
        msg: "[несериализуемая запись]",
      });
    }
    this.write(line);
  }
}
