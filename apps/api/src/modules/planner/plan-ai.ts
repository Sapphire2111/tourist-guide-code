// Живой план «Мій план» через Claude (флаг planner.ai, решение владельца 04.11.2026): параметры туриста (дни, діти,
// авто/пішки, сезон, інтереси, жильё) → заказ (brief) генератора сценариев → кандидаты ТОЛЬКО из опубликованных мест
// каталога региона (scenarios-gen/candidates) → один запрос к Claude со структурированным ответом → та же проверка
// программой (scenarios-gen/validate: реальные места, время и дорога, световой день, сезон, длительности, тексты)
// плюс погода (без гор в опасный день). Не прошёл — одна повторная попытка с ошибками; снова нет — null, планировщик
// отдаёт правиловый план. Разнообразие: случайный seed (добавка к баллу кандидатов), акцент дня и подсказка «інакше,
// ніж попередні плани». Без Nest и БД.
import type Anthropic from "@anthropic-ai/sdk";
import type { LonLat, ScenarioSeason, UserPlanItemRecord } from "../../db/index.js";
import type { Brief, Theme } from "../../scenarios-gen/briefs.js";
import { selectCandidates, type CandidateSet } from "../../scenarios-gen/candidates.js";
import type { GenCatalog, GenPlace } from "../../scenarios-gen/catalog.js";
import { addMessage, answerText, emptyUsage, type Usage } from "../../scenarios-gen/generate.js";
import {
  GEN_BETAS,
  GEN_MODEL,
  OUTPUT_SCHEMA,
  parseScenario,
  SYSTEM_PROMPT,
  userPrompt,
  type GenParams,
} from "../../scenarios-gen/prompt.js";
import { validateScenario, type ScenarioDraft } from "../../scenarios-gen/validate.js";
import type { ScenarioTag } from "./planner.dto.js";
import { slotOf } from "./plan-options.js";
import { isMountainHike } from "./visit-duration.js";

/**
 * Модель — Claude Opus 5.5 (по skill claude-api: модель по умолчанию; размышление у неё не выключается, глубину задаёт
 * effort). Для живого ответа — effort low: короткое размышление, ответ за десятки секунд, а не минуты.
 */
export const PLANNER_AI_MODEL = GEN_MODEL;
export const PLANNER_AI_EFFORT = "low" as const;
/** Ответ — JSON плана на ≤ PLANNER_AI_DAYS_MAX дней (~2–4 тыс. токенов) плюс короткое размышление. */
export const PLANNER_AI_MAX_TOKENS = 12_000;
/** Предел одного запроса к Claude, мс (турист ждёт на экране). */
export const PLANNER_AI_TIMEOUT_MS = 35_000;
/** Повторная попытка — только если от первой прошло меньше (иначе туристу ждать больше минуты). */
export const PLANNER_AI_RETRY_BEFORE_MS = 25_000;
/** Дольше — правиловый план (длинный ответ модели не уложится в живое ожидание). */
export const PLANNER_AI_DAYS_MAX = 5;

/** Кандидатов в промпте: меньше, чем у генератора (быстрее и дешевле), растёт с числом дней. */
export function liveLimits(days: number) {
  return {
    focus: Math.min(48, 18 + 6 * days),
    meals: Math.min(24, 10 + 3 * days),
    relax: 6,
    other: Math.min(16, 6 + 2 * days),
  };
}
/** Случайная добавка к баллу кандидата (балл популярного места ~3–5): заметно меняет выборку, лучшие остаются. */
export const CANDIDATE_JITTER = 2.5;

/** Интересы туриста (теги сценариев) → категории в центре плана. */
const INTEREST_FOCUS: Partial<Record<ScenarioTag, readonly string[]>> = {
  hiking: ["nature", "sights", "active"],
  mountains: ["nature", "active", "sights"],
  waterfalls: ["nature", "sights"],
  active: ["active", "entertainment", "nature"],
  culture: ["museums", "sights", "markets", "souvenirs"],
  gastro: ["restaurants", "kolyby", "cafes", "markets"],
  relax: ["chany", "spa", "cafes"],
  romantic: ["chany", "spa", "cafes", "sights"],
  ski: ["ski-resorts", "ski-lifts", "ski-rental", "ski-schools"],
  excursion: ["excursions", "sights", "museums"],
  budget: ["nature", "sights", "cafes"],
  premium: ["spa", "restaurants", "chany"],
};
const DEFAULT_FOCUS = ["nature", "sights", "museums", "active", "entertainment"] as const;

const INTEREST_UK: Partial<Record<ScenarioTag, string>> = {
  hiking: "походи",
  mountains: "гори",
  waterfalls: "водоспади",
  active: "активний відпочинок",
  culture: "культура й ремесла",
  gastro: "гастрономія",
  relax: "релакс",
  romantic: "романтика",
  ski: "лижі",
  excursion: "екскурсії",
  budget: "бюджетно",
  premium: "преміум",
};

/** Акценты: каждый запрос — свой (по seed), в рамках интересов туриста. */
const ACCENTS = [
  "більше природи й неспішних прогулянок",
  "місцева культура, ремесла й гуцульська кухня",
  "менш відомі, але гарні місця замість найпопулярніших",
  "компактна логістика: мінімум переїздів",
  "активності й розваги",
  "смачна їжа й затишні заклади",
] as const;

export type PlanAiParams = {
  days: number;
  children: number;
  withCar: boolean;
  season: ScenarioSeason;
  /** Где живёт турист (или центр региона): центр подбора. */
  center: LonLat;
  /** Название точки для промпта (жильё или населённый пункт). */
  centerName: string;
  interests: readonly ScenarioTag[];
  /** Места прошлых планов туриста за сессию: штраф к баллу и подсказка «інакше». */
  avoid: readonly string[];
  /** Дни с опасной для гор погодой (прогноз). */
  noMountainDays: ReadonlySet<number>;
  seed: number;
};

export function accentOf(seed: number): string {
  return ACCENTS[Math.abs(seed) % ACCENTS.length]!;
}

/** Заказ генератора из параметров туриста. */
export function planBrief(p: PlanAiParams): Brief {
  const focus = p.interests.length
    ? [...new Set(p.interests.flatMap((t) => INTEREST_FOCUS[t] ?? []))]
    : [...DEFAULT_FOCUS];
  if (p.children > 0) focus.push("kids", "entertainment");
  const interests = p.interests.map((t) => INTEREST_UK[t]).filter(Boolean);
  const ask = [
    `Живий план відпочинку для туриста на ${p.days} ${p.days === 1 ? "день" : "дні"}`,
    p.children > 0 ? `з дітьми (${p.children})` : null,
    p.withCar ? "на авто" : "пішки",
    `жильё/старт — ${p.centerName}`,
    interests.length ? `інтереси: ${interests.join(", ")}` : null,
    `акцент цього варіанту: ${accentOf(p.seed)}`,
  ]
    .filter(Boolean)
    .join("; ");
  const theme: Theme = {
    code: "mix",
    ask: `${ask}.`,
    focus: [...new Set(focus)],
    tags: [],
    seasons: [[p.season]],
    days: [p.days],
    radius: p.withCar ? (p.days === 1 ? 25_000 : 35_000) : 3_000,
    kids: p.children > 0,
    noCar: !p.withCar,
  };
  return { code: "live-plan", theme, area: "live", seasons: [p.season], days: p.days, center: p.center };
}

/** Кандидаты живого плана: seed меняет выборку, места прошлых планов — со штрафом (как повторы в генераторе). */
export function planCandidates(b: Brief, catalog: GenCatalog, p: PlanAiParams): CandidateSet {
  const used = new Map<string, number>();
  for (const id of p.avoid) used.set(id, (used.get(id) ?? 0) + 1);
  const noMountains = p.noMountainDays.size > 0 && p.noMountainDays.size >= p.days;
  // Все дни опасны для гор — горных походов среди кандидатов нет вовсе.
  const places = noMountains ? catalog.places.filter((x) => !isMountainHike(x)) : catalog.places;
  return selectCandidates(b, { ...catalog, places }, used, {
    max: liveLimits(p.days),
    seed: p.seed,
    jitter: CANDIDATE_JITTER,
  });
}

/** Доп. правила живого плана (постоянный текст — в кэше вместе с системным промптом генератора). */
const LIVE_RULES = `

Це живий план для конкретного туриста, який чекає на екрані: відповідай без зайвих роздумів.
- Примітка до пункту — до 160 символів, одне-два закінчені речення; альтернативи — 1–2.
- Опис — одне речення. Назва — коротка, про цей план (не загальна).
- Кожен новий запит — новий варіант: дотримуйся акценту із запиту й не повторюй місця з переліку «попередні плани», якщо є інші хороші варіанти.
- Дні з позначкою «небезпечно для гір» — без походів на вершини й гірських маршрутів.`;

export const PLANNER_AI_SYSTEM = SYSTEM_PROMPT + LIVE_RULES;

/** Изменяемая часть запроса: заказ и кандидаты генератора, прошлые планы, погода, ошибки прошлой попытки. */
export function planPrompt(
  b: Brief,
  set: CandidateSet,
  p: PlanAiParams,
  avoidNames: readonly string[],
  retryErrors: readonly string[],
): string {
  const parts = [userPrompt(b, set, retryErrors)];
  if (avoidNames.length)
    parts.push(`\nВідмінний від попередніх планів цього туриста (вони вже були): ${avoidNames.join(", ")}.`);
  if (p.noMountainDays.size)
    parts.push(
      `\nПрогноз: ${[...p.noMountainDays]
        .sort((a, c) => a - c)
        .map((d) => `день ${d}`)
        .join(", ")} — небезпечно для гір (гроза, вітер, снігопад чи ожеледь).`,
    );
  return parts.join("\n");
}

export function planParams(userText: string): GenParams {
  return {
    model: PLANNER_AI_MODEL,
    max_tokens: PLANNER_AI_MAX_TOKENS,
    // Размышление адаптивное (у Opus 5.5 всегда включено), effort low — живой ответ. temperature у Opus 5.5 нет
    // (400): разнообразие — seed кандидатов, акцент и подсказка о прошлых планах.
    output_config: { effort: PLANNER_AI_EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: [{ type: "text", text: PLANNER_AI_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
    // Отказ модели — запасная модель на стороне API (skill claude-api).
    betas: [...GEN_BETAS],
    fallbacks: "default",
  };
}

/** Порт Claude (подменяется в тестах). */
export type PlanAiMessages = {
  create(params: GenParams, opts: { timeout: number }): Promise<Anthropic.Beta.Messages.BetaMessage>;
};

/** Сбой вызова Claude (сеть, HTTP, таймаут) — от адаптера SDK; текст ошибки не нужен. */
export class PlanAiCallError extends Error {
  constructor(
    readonly timeout: boolean,
    readonly status?: number,
  ) {
    super(`planner ai: ${timeout ? "timeout" : `upstream ${status ?? "network"}`}`);
  }
}

/** Погода: горный поход в день с опасным прогнозом — ошибка (модель получает её при повторе). */
export function weatherErrors(draft: ScenarioDraft, set: CandidateSet, p: PlanAiParams): string[] {
  if (!p.noMountainDays.size) return [];
  const byId = new Map<string, GenPlace>([...set.byRef.values()].map((x) => [x.id, x]));
  return draft.items.flatMap((i) => {
    const place = byId.get(i.placeId);
    return place && p.noMountainDays.has(i.dayNo) && isMountainHike(place)
      ? [`день ${i.dayNo}: ${place.name} — гірський похід у день з небезпечним прогнозом, заміни`]
      : [];
  });
}

export type PlanAiFailure = "no_candidates" | "invalid" | "upstream" | "timeout";

export type PlanAiResult =
  | { ok: true; draft: ScenarioDraft; attempts: number; usage: Usage; model: string }
  | { ok: false; reason: PlanAiFailure; errors: string[]; attempts: number; usage: Usage };

/**
 * План через Claude: попытка → проверка программой; ошибки — одна повторная попытка с их перечнем (если первая
 * уложилась в PLANNER_AI_RETRY_BEFORE_MS). Исключения API не выходят наружу: результат — ok или причина отказа.
 */
export async function generateLivePlan(
  messages: PlanAiMessages,
  catalog: GenCatalog,
  p: PlanAiParams,
  opts: { now?: () => number; avoidNames?: readonly string[] } = {},
): Promise<PlanAiResult> {
  const now = opts.now ?? Date.now;
  const usage = emptyUsage();
  const b = planBrief(p);
  const set = planCandidates(b, catalog, p);
  if (!set.viable)
    return { ok: false, reason: "no_candidates", errors: [set.reason ?? ""], attempts: 0, usage };
  const started = now();
  let errors: string[] = [];
  let reason: PlanAiFailure = "invalid";
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2 && now() - started > PLANNER_AI_RETRY_BEFORE_MS) break;
    attempts = attempt;
    const params = planParams(planPrompt(b, set, p, opts.avoidNames ?? [], errors));
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await messages.create(params, { timeout: PLANNER_AI_TIMEOUT_MS });
    } catch (e) {
      usage.failedRequests++;
      const timeout = e instanceof PlanAiCallError && e.timeout;
      // Сбой API (не ответ модели) — повтор без перечня ошибок; таймаут — без повтора (турист уже ждал).
      reason = timeout ? "timeout" : "upstream";
      errors = [];
      if (timeout) break;
      continue;
    }
    addMessage(usage, res, params.model);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      if (res.stop_reason === "refusal") usage.refusals++;
      else usage.maxTokensGen++;
      reason = "upstream";
      errors = [`модель зупинилась: ${res.stop_reason}`];
      continue;
    }
    const gen = parseScenario(answerText(res.content));
    reason = "invalid";
    if (!gen) {
      errors = ["відповідь не JSON за схемою"];
      continue;
    }
    let draft: ScenarioDraft | null;
    try {
      const r = validateScenario(b, set, gen);
      draft = r.draft;
      errors = r.errors;
    } catch (e) {
      draft = null;
      errors = [`відповідь не за схемою: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (draft) {
      const wx = weatherErrors(draft, set, p);
      if (!wx.length) return { ok: true, draft, attempts, usage, model: res.model ?? params.model };
      errors = wx;
    }
  }
  return { ok: false, reason, errors, attempts, usage };
}

/** Черновик → пункты плана пользователя: часть дня — по времени, позиция — порядок в дне. */
export function draftToPlanItems(draft: ScenarioDraft, newId: () => string): UserPlanItemRecord[] {
  const pos = new Map<number, number>();
  return draft.items.map((i) => {
    const position = pos.get(i.dayNo) ?? 0;
    pos.set(i.dayNo, position + 1);
    return {
      id: newId(),
      dayNo: i.dayNo,
      position,
      placeId: i.placeId,
      timeHint: i.timeHint,
      durationMin: i.durationMin,
      note: i.note,
      alternatives: i.alternatives,
      replacedPlaceId: null,
      slot: slotOf({ timeHint: i.timeHint }),
    };
  });
}
