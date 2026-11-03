// Суточный бюджет ассистента: единицы (запрос к Claude — 1, распознавание голоса — 2) на всё api и на пользователя.
// Счётчики — в хранилище rate limit (Redis при REDIS_URL — общий для инстансов и переживает рестарт; иначе память
// процесса). Redis недоступен — счёт продолжается в памяти процесса (предел не отключается).
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  type RateLimitKey,
  type RateLimitStore,
} from "../rate-limit/index.js";
import { ASSISTANT_CONFIG, type AssistantConfig } from "./providers.js";

export const DAILY_LIMIT_DEFAULT = 500;
export const USER_DAILY_LIMIT_DEFAULT = 40;
/** Стоимость в единицах. */
export const BUDGET_UNITS = { query: 1, voice: 2 } as const;

const DAY_MS = 24 * 3600_000;

@Injectable()
export class AssistantBudget {
  private readonly log = new Logger("AssistantBudget");
  private readonly memory = new MemoryRateLimitStore(() => this.now().getTime());
  private readonly store: RateLimitStore;
  private warnedAt = -Infinity;

  constructor(
    @Inject(ASSISTANT_CONFIG) private readonly config: AssistantConfig,
    // Нет RateLimitModule (тесты) — память процесса.
    @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore,
  ) {
    this.store = store ?? this.memory;
  }

  /** Часы (подменяются в тестах). */
  now: () => Date = () => new Date();

  /**
   * Списать units единиц: сначала пользователь (сверх его предела — 429 errors.assistant.dailyLimit, общий счётчик
   * не трогается — один пользователь не исчерпает общий бюджет), затем общий (сверх — 503). Окно — до конца суток UTC.
   */
  async spend(userId: string, units: number): Promise<void> {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const windowMs = DAY_MS - (now.getTime() % DAY_MS) + 60_000;
    const user = await this.hit({ key: `assistant:day:${day}:u:${userId}`, windowMs }, units);
    if (user > (this.config.userDailyLimit ?? USER_DAILY_LIMIT_DEFAULT))
      throw new ApiError("RATE_LIMITED", {
        messageKey: "errors.assistant.dailyLimit",
        details: { reason: "daily_user_limit" },
      });
    const total = await this.hit({ key: `assistant:day:${day}`, windowMs }, units);
    if (total > (this.config.dailyLimit ?? DAILY_LIMIT_DEFAULT))
      throw new ApiError("SERVICE_UNAVAILABLE", {
        messageKey: "errors.assistant.unavailable",
        details: { reason: "daily_limit" },
      });
  }

  /** +units к ключу (на Redis — одна команда); значение после. Redis недоступен — память процесса. */
  private async hit(key: RateLimitKey, units: number): Promise<number> {
    const keys = Array.from({ length: units }, () => key);
    let hits;
    try {
      hits = await this.store.hit(keys);
    } catch {
      const now = this.now().getTime();
      // Предупреждение — не чаще раза в минуту (Redis лежит — каждый запрос иначе писал бы в лог).
      if (now - this.warnedAt >= 60_000) {
        this.warnedAt = now;
        this.log.warn("Счётчик ассистента недоступен (Redis) — считаю в памяти процесса");
      }
      hits = await this.memory.hit(keys);
    }
    return hits[hits.length - 1]!.count;
  }
}
