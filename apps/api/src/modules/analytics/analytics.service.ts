import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  analyticsEventSchema,
  analyticsTimeIssue,
  clientAnalyticsBatchSchema,
  describeAnalyticsIssues,
  type AnalyticsEvent,
  type ClientAnalyticsEvent,
  type FieldError,
} from "@tg/shared";
import { ApiError } from "../../common/http/index.js";
import { ANALYTICS_SINK, AnalyticsUnknownRegionError, type AnalyticsSink } from "./analytics.sink.js";

/** Включён ли приём событий фронтенда (boolean; AnalyticsModuleOptions.clientEvents). */
export const ANALYTICS_CLIENT_EVENTS_ENABLED = Symbol("ANALYTICS_CLIENT_EVENTS_ENABLED");

type Issue = { path: readonly PropertyKey[]; code: string };

/** Ошибки zod → поля конверта VALIDATION_FAILED (без значений: в событии может оказаться ПДн). */
function toFieldErrors(issues: readonly Issue[]): FieldError[] {
  return issues.map((i) => ({
    field: i.path.map(String).join("."),
    constraint: i.code,
    messageKey: `errors.validation.${i.code}`,
  }));
}

/**
 * Эмиссия аналитических событий (T1-25, D-56): проверка по каталогу @tg/shared, затем запись через sink
 * (очередь → worker → analytics_events или напрямую — см. analytics.sink.ts). Невалидное событие не пишется:
 * предупреждение в лог (только пути и коды ошибок) и ошибка вызывающему.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger("Analytics");

  constructor(
    @Inject(ANALYTICS_SINK) private readonly sink: AnalyticsSink,
    @Inject(ANALYTICS_CLIENT_EVENTS_ENABLED) private readonly clientEventsEnabled: boolean,
  ) {}

  /**
   * Серверное событие (любое из каталога). Невалидное — ошибка программы: Error, событие не пишется.
   * Вызывающий решает, критична ли аналитика для его операции (обычно — нет: ловить и логировать).
   */
  async emit(event: AnalyticsEvent): Promise<void> {
    const parsed = analyticsEventSchema.safeParse(event);
    if (!parsed.success) {
      const reason = describeAnalyticsIssues(parsed.error.issues);
      this.logger.warn(`Событие ${String((event as { event?: unknown }).event)} отклонено схемой: ${reason}`);
      throw new Error(`Аналитическое событие не по схеме: ${reason}`);
    }
    await this.sink.write([parsed.data]);
  }

  /**
   * Пакет от фронтенда: только client-события (конверт без pseudonymousUserId), время в допустимом окне, regionId —
   * существующий регион; иначе 400 VALIDATION_FAILED. Приём выключен (ANALYTICS_CLIENT_EVENTS=off) — 404 NOT_FOUND.
   */
  async acceptClientBatch(body: unknown, now = new Date()): Promise<number> {
    if (!this.clientEventsEnabled) throw new ApiError("NOT_FOUND");
    const parsed = clientAnalyticsBatchSchema.safeParse(body);
    if (!parsed.success) this.reject(parsed.error.issues);
    const events: ClientAnalyticsEvent[] = parsed.data.events;
    const timeIssues = events.flatMap((e, i) => {
      const issue = analyticsTimeIssue(e.occurredAt, now);
      return issue ? [{ path: ["events", i, "occurredAt"], code: "out_of_range" }] : [];
    });
    if (timeIssues.length) this.reject(timeIssues);
    // TODO(T1-26): pseudonymousUserId — из сессии (псевдоним актора), regionId — из контекста входа; пока клиент
    // присылает только anonymousId (pseudonymousUserId в клиентском конверте нет — strict-схема его отклоняет),
    // а regionId клиента проверяется только на существование региона.
    try {
      await this.sink.write(events);
    } catch (err) {
      if (err instanceof AnalyticsUnknownRegionError)
        this.reject(err.indices.map((i) => ({ path: ["events", i, "regionId"], code: "not_found" })));
      throw err;
    }
    return events.length;
  }

  private reject(issues: readonly Issue[]): never {
    this.logger.warn(`Пакет событий отклонён: ${describeAnalyticsIssues(issues)}`);
    throw new ApiError("VALIDATION_FAILED", { details: { fields: toFieldErrors(issues) } });
  }
}
