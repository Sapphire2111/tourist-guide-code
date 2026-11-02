// Суточный бюджет ассистента: единицы (запрос к Claude — 1, распознавание голоса — 2) на всё api и на пользователя.
// Счётчики — в хранилище rate limit (Redis при REDIS_URL — общий для инстансов и переживает рестарт; иначе память
// процесса). Redis недоступен — счёт продолжается в памяти процесса (предел не отключается).
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import { MemoryRateLimitStore, RATE_LIMIT_STORE, type RateLimitStore } from "../rate-limit/index.js";
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
   * Списать units единиц: сверх предела пользователя — 429 errors.assistant.dailyLimit, сверх общего — 503
   * errors.assistant.unavailable. Окно — до конца суток UTC.
   */
  async spend(userId: string, units: number): Promise<void> {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const windowMs = DAY_MS - (now.getTime() % DAY_MS) + 60_000;
    const total = { key: `assistant:day:${day}`, windowMs };
    const user = { key: `assistant:day:${day}:u:${userId}`, windowMs };
    // Ключ повторяется units раз — на Redis всё равно одна команда (INCR на каждый).
    const keys = Array.from({ length: units }, () => [total, user]).flat();
    let hits;
    try {
      hits = await this.store.hit(keys);
    } catch {
      this.log.warn("Счётчик ассистента недоступен (Redis) — считаю в памяти процесса");
      hits = await this.memory.hit(keys);
    }
    const totalCount = hits[hits.length - 2]!.count;
    const userCount = hits[hits.length - 1]!.count;
    if (userCount > (this.config.userDailyLimit ?? USER_DAILY_LIMIT_DEFAULT))
      throw new ApiError("RATE_LIMITED", {
        messageKey: "errors.assistant.dailyLimit",
        details: { reason: "daily_user_limit" },
      });
    if (totalCount > (this.config.dailyLimit ?? DAILY_LIMIT_DEFAULT))
      throw new ApiError("SERVICE_UNAVAILABLE", {
        messageKey: "errors.assistant.unavailable",
        details: { reason: "daily_limit" },
      });
  }
}
