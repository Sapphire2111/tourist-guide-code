// Прогон заказов: выбор (без готовых кодов журнала), пул с лимитом расходов, запись каждого результата в журнал сразу,
// итоги и оценка без запросов. Ошибка одного заказа записывается и не рушит пул. Модель и файлы подменяются в тестах.
import { selectCandidates, type CandidateSet } from "./candidates.js";
import type { Brief, ThemeCode } from "./briefs.js";
import type { GenCatalog } from "./catalog.js";
import { addUsage, emptyUsage, pool, tokensCost, usd, type GenOutcome, type Usage } from "./generate.js";
import { latestByCode, totalUsage, type GenRecord } from "./journal.js";
import { CRITIC_SYSTEM, GEN_MODEL, SYSTEM_PROMPT, userPrompt } from "./prompt.js";

export type Order = { brief: Brief; set: CandidateSet };

/**
 * Заказы: по кругу тем, только те, что собираются из каталога. Готовые коды журнала не генерируем, но они входят в
 * --count: продолжение прогона на 200 не заказывает ещё 200.
 */
export function chooseOrders(
  briefs: Iterable<Brief>,
  catalog: GenCatalog,
  args: { count: number; themes: ReadonlySet<ThemeCode>; areas: ReadonlySet<string> },
  ready: ReadonlySet<string>,
): { chosen: Order[]; skipped: { code: string; reason: string }[]; resumed: number } {
  const skipped: { code: string; reason: string }[] = [];
  const chosen: Order[] = [];
  let resumed = 0;
  for (const brief of briefs) {
    if (chosen.length + resumed >= args.count) break;
    if (args.themes.size && !args.themes.has(brief.theme.code)) continue;
    if (args.areas.size && !args.areas.has(brief.area)) continue;
    if (ready.has(brief.code)) {
      resumed++;
      continue;
    }
    if (catalog.existingCodes.has(brief.code)) {
      skipped.push({ code: brief.code, reason: "уже есть в БД" });
      continue;
    }
    const set = selectCandidates(brief, catalog);
    if (!set.viable) {
      skipped.push({ code: brief.code, reason: set.reason ?? "не собрать" });
      continue;
    }
    chosen.push({ brief, set });
  }
  return { chosen, skipped, resumed };
}

export type RunResult = {
  records: GenRecord[];
  /** Заказы, которые не начаты: сработал лимит или журнал перестал писаться. */
  notStarted: string[];
  stoppedBy: "budget" | "journal" | null;
  /** Токены и деньги этого запуска (включая заказы, что ещё шли в момент остановки). */
  usage: Usage;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runOrders(opts: {
  orders: readonly Order[];
  region: string;
  concurrency: number;
  /** Лимит на весь журнал, $; null — без лимита. */
  maxUsd: number | null;
  /** Уже потрачено по журналу прошлых запусков, $. */
  spentBefore: number;
  generate: (order: Order, usage: Usage) => Promise<GenOutcome>;
  append: (record: GenRecord) => Promise<void>;
  log: (line: string) => void;
}): Promise<RunResult> {
  // Счётчики каждого заказа живут здесь: лимит видит и ещё не законченные заказы, исключение не теряет потраченное.
  const usages: Usage[] = [];
  const spent = () => usages.reduce((sum, u) => sum + u.costUsd, opts.spentBefore);
  const records: GenRecord[] = [];
  const started = new Set<string>();
  let stoppedBy: RunResult["stoppedBy"] = null;
  const shouldStop = () => {
    if (!stoppedBy && opts.maxUsd !== null && spent() >= opts.maxUsd) stoppedBy = "budget";
    return stoppedBy !== null;
  };

  await pool(
    opts.orders,
    opts.concurrency,
    async (order) => {
      const usage = emptyUsage();
      usages.push(usage);
      started.add(order.brief.code);
      const base = { code: order.brief.code, region: opts.region, usage };
      let record: GenRecord;
      try {
        const r = await opts.generate(order, usage);
        record = {
          ...base,
          status: r.draft ? "ok" : "rejected",
          draft: r.draft,
          errors: r.errors,
          fixes: r.fixes,
          attempts: r.attempts,
          critic: r.critic,
          model: r.model,
          at: new Date().toISOString(),
        };
      } catch (err) {
        record = {
          ...base,
          status: "error",
          draft: null,
          errors: [message(err)],
          fixes: [],
          attempts: 0,
          critic: [],
          model: null,
          at: new Date().toISOString(),
        };
      }
      records.push(record);
      try {
        await opts.append(record);
      } catch (err) {
        // Без журнала дальше тратить деньги нельзя; готовое остаётся в памяти и попадёт в отчёт и запись в БД.
        stoppedBy = "journal";
        opts.log(`Журнал не пишется, новые заказы не берём: ${message(err)}`);
      }
      const fixedByCritic = record.critic.filter((c) => c.accepted && c.verdict === "fix").length;
      const served = record.model && record.model !== GEN_MODEL ? `, запасна модель ${record.model}` : "";
      opts.log(
        `[${records.length}/${opts.orders.length}] ${record.code}: ` +
          (record.draft
            ? `ок (${record.draft.items.length} пунктов, попыток ${record.attempts}, правок критика ${fixedByCritic}${served})`
            : `отброшен — ${record.errors.slice(0, 2).join("; ")}`) +
          ` ≈ $${usd(usage)}, всего ≈ $${usd({ costUsd: spent() })}`,
      );
    },
    shouldStop,
  );
  const usage = emptyUsage();
  for (const u of usages) addUsage(usage, u);
  return {
    records,
    notStarted: opts.orders.map((o) => o.brief.code).filter((c) => !started.has(c)),
    stoppedBy,
    usage,
  };
}

/** Итоги по всему журналу: сценарии, сбои критика, средняя цена, фактические модели. */
export function summarize(records: readonly GenRecord[]) {
  const latest = latestByCode(records);
  const usage = totalUsage(records);
  const ok = latest.filter((r) => r.draft);
  const models: Record<string, number> = {};
  for (const r of ok) if (r.model) models[r.model] = (models[r.model] ?? 0) + 1;
  const criticRounds = latest.flatMap((r) => r.critic);
  return {
    ok: ok.length,
    failed: latest.length - ok.length,
    usage,
    /** Цена готового сценария: все деньги (и за отброшенные, и за повторы) делим на готовые. */
    usdPerScenario: ok.length ? usd({ costUsd: usage.costUsd / ok.length }) : null,
    criticErrors: criticRounds.filter((c) => c.verdict === "error").length,
    criticFixes: criticRounds.filter((c) => c.accepted && c.verdict === "fix").length,
    models,
  };
}

/** Кириллица: ~1,5 символа на токен (замер прогона 03.11.2026). */
const CHARS_PER_TOKEN = 1.5;
/** Нижняя граница: ответ без размышления (замер Sonnet 03.11.2026, ~600 токенов). */
const PLAN_OUTPUT_MIN = 700;
/** Ориентир вывода на запрос: сценарий 2–5 тыс. токенов плюс размышление. НЕ замер — уточняется пилотом. */
const PLAN_OUTPUT_GUESS = 8000;
/** Ориентир размера чернетки и расчётов в запросе критика, символов. */
const PLAN_CRITIC_TAIL_CHARS = 4000;

/**
 * Оценка без запросов. lowerBound — по одному запросу на заказ, без размышления и критика: дешевле быть не может.
 * guess — генерация и все раунды критика с размышлением, без кэша и повторов: порядок суммы, не замер.
 */
export function planEstimate(orders: readonly Order[], criticRounds: number) {
  const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
  let genInput = 0;
  let criticInput = 0;
  for (const { brief, set } of orders) {
    const user = userPrompt(brief, set).length;
    genInput += tokens(SYSTEM_PROMPT.length + user);
    criticInput += tokens(CRITIC_SYSTEM.length + user + PLAN_CRITIC_TAIL_CHARS) * criticRounds;
  }
  const estimate = (input: number, output: number, requests: number): Usage => {
    const t = { input, cacheWrite: 0, cacheRead: 0, output };
    return { ...emptyUsage(), ...t, requests, costUsd: tokensCost(GEN_MODEL, t) };
  };
  const requests = orders.length * (1 + criticRounds);
  return {
    lowerBound: estimate(genInput, orders.length * PLAN_OUTPUT_MIN, orders.length),
    guess: estimate(genInput + criticInput, requests * PLAN_OUTPUT_GUESS, requests),
  };
}
