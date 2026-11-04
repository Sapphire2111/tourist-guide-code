// Живой план через Claude (флаг planner.ai): клиент Anthropic, суточные пределы (общий и на пользователя — счётчики в
// хранилище rate limit, как у ассистента), каталог региона для кандидатов (кэш), места прошлых планов туриста за
// сессию (разнообразие) и учёт стоимости в логе. Ключ — ANTHROPIC_API_KEY; нет ключа — enabled=false (правиловый
// план). Текст туриста и id пользователя в лог не пишутся.
import { randomInt } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectDb, type Db } from "../../db/index.js";
import { loadRegionCatalog, type GenCatalog } from "../../scenarios-gen/catalog.js";
import { usd } from "../../scenarios-gen/generate.js";
import {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  type RateLimitKey,
  type RateLimitStore,
} from "../rate-limit/index.js";
import {
  generateLivePlan,
  PlanAiCallError,
  PLANNER_AI_DAYS_MAX,
  type PlanAiMessages,
  type PlanAiParams,
  type PlanAiResult,
} from "./plan-ai.js";

export const PLANNER_AI_CONFIG = Symbol("PLANNER_AI_CONFIG");
export const PLANNER_AI_MESSAGES = Symbol("PLANNER_AI_MESSAGES");

export type PlannerAiConfig = {
  anthropicApiKey?: string | undefined;
  /** Планов через Claude в сутки (UTC) на всё api. */
  dailyLimit?: number;
  /** И на пользователя. */
  userDailyLimit?: number;
};

export const PLANNER_AI_DAILY_LIMIT_DEFAULT = 300;
export const PLANNER_AI_USER_DAILY_LIMIT_DEFAULT = 15;
/** Каталог для кандидатов — кэш на процесс (правки админки видны не позже чем через 5 мин). */
const CATALOG_TTL_MS = 5 * 60_000;
/** «Сессия» туриста для разнообразия: места планов за последние 3 часа, не больше 3 планов. */
const SESSION_TTL_MS = 3 * 3600_000;
const SESSION_PLANS = 3;
const SESSION_USERS_MAX = 5_000;
const DAY_MS = 24 * 3600_000;

/** Адаптер SDK: ключ передаётся явно; ошибки — PlanAiCallError (только статус, без тела). */
export function createPlannerMessages(apiKey: string | undefined): PlanAiMessages | null {
  if (!apiKey) return null;
  // Один повтор SDK (408/409/429/5xx до ответа) — не оплачивается токенами; живое ожидание ограничено timeout.
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  return {
    async create(params, opts) {
      try {
        return await client.beta.messages.create({ ...params, stream: false }, { timeout: opts.timeout });
      } catch (e) {
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new PlanAiCallError(true);
        if (e instanceof Anthropic.APIError) throw new PlanAiCallError(false, e.status ?? undefined);
        throw e;
      }
    },
  };
}

export type PlanAiOutcome =
  | (PlanAiResult & { ok: true })
  | { ok: false; reason: "limit" | "too_long" | PlanAiFailureReason };
type PlanAiFailureReason = Extract<PlanAiResult, { ok: false }>["reason"];

@Injectable()
export class PlannerAi {
  private readonly log = new Logger("PlannerAi");
  private readonly memory = new MemoryRateLimitStore(() => this.now());
  private readonly store: RateLimitStore;
  private readonly catalogs = new Map<string, { at: number; catalog: Promise<GenCatalog> }>();
  private readonly sessions = new Map<string, { at: number; ids: string[] }[]>();

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PLANNER_AI_CONFIG) private readonly config: PlannerAiConfig,
    @Optional() @Inject(PLANNER_AI_MESSAGES) private readonly messages?: PlanAiMessages | null,
    // Нет RateLimitModule (тесты) — память процесса.
    @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore,
  ) {
    this.store = store ?? this.memory;
  }

  /** Часы и seed (подменяются в тестах). */
  now: () => number = () => Date.now();
  seed: () => number = () => randomInt(0, 2 ** 31);

  /** Есть ключ Claude. */
  get enabled(): boolean {
    return Boolean(this.messages);
  }

  /** Каталог региона (опубликованные места с рейтингом, описанием, графиком) — кэш CATALOG_TTL_MS. */
  catalog(region: { id: string; timezone: string }): Promise<GenCatalog> {
    const hit = this.catalogs.get(region.id);
    if (hit && this.now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
    const catalog = loadRegionCatalog(this.db, region);
    this.catalogs.set(region.id, { at: this.now(), catalog });
    catalog.catch(() => this.catalogs.delete(region.id));
    return catalog;
  }

  /** Места прошлых планов пользователя за сессию (свежие первыми). */
  recent(userId: string): string[] {
    const list = (this.sessions.get(userId) ?? []).filter((s) => this.now() - s.at < SESSION_TTL_MS);
    return [...new Set([...list].reverse().flatMap((s) => s.ids))];
  }

  private remember(userId: string, ids: readonly string[]): void {
    const list = (this.sessions.get(userId) ?? []).filter((s) => this.now() - s.at < SESSION_TTL_MS);
    list.push({ at: this.now(), ids: [...new Set(ids)] });
    this.sessions.delete(userId);
    this.sessions.set(userId, list.slice(-SESSION_PLANS));
    // Память ограничена: самые давние пользователи вытесняются.
    while (this.sessions.size > SESSION_USERS_MAX) this.sessions.delete(this.sessions.keys().next().value!);
  }

  /**
   * План через Claude. Пределы: сначала пользователь, затем общий; сверх — reason "limit" (правиловый план, не
   * ошибка). Успех — места плана запоминаются для разнообразия следующих запросов.
   */
  async generate(
    userId: string,
    region: { id: string; timezone: string },
    params: Omit<PlanAiParams, "seed" | "avoid"> & { avoid?: readonly string[] },
  ): Promise<PlanAiOutcome> {
    if (!this.messages) return { ok: false, reason: "upstream" };
    if (params.days > PLANNER_AI_DAYS_MAX) return { ok: false, reason: "too_long" };
    if (!(await this.take(userId))) {
      this.log.log("Planner AI: суточный предел — правиловый план");
      return { ok: false, reason: "limit" };
    }
    const catalog = await this.catalog(region);
    const avoid = [...new Set([...(params.avoid ?? []), ...this.recent(userId)])];
    const byId = new Map(catalog.places.map((p) => [p.id, p.name]));
    const avoidNames = avoid.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).slice(0, 20);
    const seed = this.seed();
    const started = this.now();
    const r = await generateLivePlan(this.messages, catalog, { ...params, avoid, seed }, { avoidNames });
    const u = r.usage;
    this.log.log(
      `Planner AI: ${r.ok ? "ok" : `fallback ${r.reason}`} days=${params.days} attempts=${r.attempts} ` +
        `ms=${this.now() - started} in=${u.input} cacheW=${u.cacheWrite} cacheR=${u.cacheRead} out=${u.output} ` +
        `cost=$${usd(u).toFixed(2)} (${u.costUsd.toFixed(4)}) served=${JSON.stringify(u.servedBy)}` +
        (r.ok ? "" : ` errors=${r.errors.length}`),
    );
    if (r.ok)
      this.remember(
        userId,
        r.draft.items.map((i) => i.placeId),
      );
    return r.ok ? r : { ok: false, reason: r.reason };
  }

  /** Списать один план: false — предел пользователя или общий (общий при отказе пользователю не тратится). */
  private async take(userId: string): Promise<boolean> {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const windowMs = DAY_MS - (now % DAY_MS) + 60_000;
    const user = await this.hit({ key: `planner-ai:day:${day}:u:${userId}`, windowMs });
    if (user > (this.config.userDailyLimit ?? PLANNER_AI_USER_DAILY_LIMIT_DEFAULT)) return false;
    const total = await this.hit({ key: `planner-ai:day:${day}`, windowMs });
    return total <= (this.config.dailyLimit ?? PLANNER_AI_DAILY_LIMIT_DEFAULT);
  }

  private async hit(key: RateLimitKey): Promise<number> {
    let hits;
    try {
      hits = await this.store.hit([key]);
    } catch {
      hits = await this.memory.hit([key]);
    }
    return hits[hits.length - 1]!.count;
  }
}
