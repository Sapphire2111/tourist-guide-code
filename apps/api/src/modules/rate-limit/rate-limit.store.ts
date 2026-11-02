import { Redis } from "ioredis";

/** Счётчик ключа в текущем окне: число запросов и сколько мс осталось до сброса окна. */
export type RateLimitHit = { count: number; resetMs: number };

/** Ключ счётчика и длина его окна. */
export type RateLimitKey = { key: string; windowMs: number };

/** Хранилище счётчиков фиксированного окна. Все ключи запроса — одной операцией (на Redis — одна команда). */
export interface RateLimitStore {
  hit(keys: readonly RateLimitKey[]): Promise<RateLimitHit[]>;
  close?(): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol("RATE_LIMIT_STORE");

/** Память процесса: local, тесты, нет REDIS_URL. Лимит на инстанс, при рестарте сбрасывается. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async hit(keys: readonly RateLimitKey[]): Promise<RateLimitHit[]> {
    const now = this.now();
    this.sweep(now);
    return keys.map(({ key, windowMs }) => {
      let c = this.counters.get(key);
      if (!c || c.expiresAt <= now) {
        c = { count: 0, expiresAt: now + windowMs };
        this.counters.set(key, c);
      }
      c.count += 1;
      return { count: c.count, resetMs: c.expiresAt - now };
    });
  }

  /** Раз в минуту выбрасывает истёкшие счётчики, чтобы Map не рос бесконечно. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, c] of this.counters) if (c.expiresAt <= now) this.counters.delete(k);
  }
}

/**
 * INCR + PTTL + PEXPIRE (только у нового ключа или ключа без срока) для каждого ключа — атомарно в одном EVALSHA:
 * одна команда Redis на запрос (Upstash free считает команды).
 */
const HIT_SCRIPT = `
local r = {}
for i, k in ipairs(KEYS) do
  local c = redis.call("INCR", k)
  local t = redis.call("PTTL", k)
  if c == 1 or t < 0 then
    redis.call("PEXPIRE", k, ARGV[i])
    t = tonumber(ARGV[i])
  end
  r[#r + 1] = c
  r[#r + 1] = t
end
return r
`;

type RedisWithHit = Redis & {
  rateLimitHit(numKeys: number, ...args: (string | number)[]): Promise<number[]>;
};

/**
 * Redis (staging/prod, общий для инстансов). Без офлайн-очереди и с таймаутом команды: Redis недоступен — быстрая
 * ошибка (интерсептор пропускает запрос), а не ожидание.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private constructor(private readonly redis: RedisWithHit) {}

  static open(url: string): RedisRateLimitStore {
    const redis = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
    });
    // Ошибки соединения видны через отказ hit() (предупреждение интерсептора); здесь — только не уронить процесс.
    redis.on("error", () => undefined);
    redis.defineCommand("rateLimitHit", { lua: HIT_SCRIPT });
    return new RedisRateLimitStore(redis as RedisWithHit);
  }

  async hit(keys: readonly RateLimitKey[]): Promise<RateLimitHit[]> {
    const flat = await this.redis.rateLimitHit(
      keys.length,
      ...keys.map((k) => k.key),
      ...keys.map((k) => k.windowMs),
    );
    return keys.map((_, i) => ({ count: Number(flat[2 * i]), resetMs: Number(flat[2 * i + 1]) }));
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
