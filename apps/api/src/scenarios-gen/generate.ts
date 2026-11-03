// Генерация сценариев: заказ → кандидаты → запрос к модели (структурированный JSON) → проверка программой; не прошёл —
// ещё попытка с перечнем ошибок. Затем «критик» (второй проход модели как опытного местного гида: реализм времени,
// логистика, усталость, еда, световой день, погода) — до N раундов; каждая правка критика снова проходит проверку
// программой, не прошла — критик получает ошибки. Ключ — ANTHROPIC_API_KEY из env (SDK читает сам), в логи не попадает.
import type Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./briefs.js";
import type { CandidateSet } from "./candidates.js";
import {
  criticParams,
  GEN_USD_PER_MTOK,
  parseCritic,
  parseScenario,
  requestParams,
  type GenParams,
  type GenScenario,
} from "./prompt.js";
import { draftFacts, draftToGen, validateScenario, type ScenarioDraft } from "./validate.js";

/** Часть клиента Anthropic, нужная генератору (подменяется в тестах). */
export type MessagesApi = Pick<Anthropic["beta"]["messages"], "create">;

/** Токены: input — без кэша; cacheWrite/cacheRead — запись и чтение кэша промпта (цены разные). */
export type Usage = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  requests: number;
};
export const emptyUsage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: 0 });

export type GenOutcome = {
  code: string;
  draft: ScenarioDraft | null;
  /** Ошибки последней попытки (draft null — сценарий отброшен). */
  errors: string[];
  fixes: string[];
  attempts: number;
  /** Замечания критика по раундам (что исправлено). */
  critic: { round: number; verdict: string; issues: string[]; accepted: boolean }[];
};

export const usd = (u: Usage, discount = 1) =>
  Math.round(
    ((u.input * GEN_USD_PER_MTOK.input +
      u.cacheWrite * GEN_USD_PER_MTOK.cacheWrite +
      u.cacheRead * GEN_USD_PER_MTOK.cacheRead +
      u.output * GEN_USD_PER_MTOK.output) /
      1e6) *
      discount *
      100,
  ) / 100;

/** Запрос к модели: текст ответа или причина отказа; токены — в usage. */
async function ask(
  messages: MessagesApi,
  params: GenParams,
  usage: Usage,
): Promise<{ text: string } | { error: string }> {
  try {
    const res = await messages.create(params);
    usage.requests++;
    usage.input += res.usage.input_tokens;
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usage.output += res.usage.output_tokens;
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens")
      return { error: `модель зупинилась: ${res.stop_reason}` };
    return { text: res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") };
  } catch (err) {
    return { error: `запит не вдався: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function generateOne(
  messages: MessagesApi,
  b: Brief,
  set: CandidateSet,
  usage: Usage,
  opts: { retries: number; criticRounds?: number },
): Promise<GenOutcome> {
  let errors: string[] = [];
  let fixes: string[] = [];
  let draft: ScenarioDraft | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= opts.retries + 1 && !draft; attempt++) {
    attempts = attempt;
    const r0 = await ask(messages, requestParams(b, set, errors), usage);
    if ("error" in r0) {
      errors = [r0.error];
      continue;
    }
    const gen = parseScenario(r0.text);
    if (!gen) {
      errors = ["відповідь не JSON за схемою"];
      continue;
    }
    const r = validateScenario(b, set, gen);
    fixes = r.fixes;
    draft = r.draft;
    errors = r.errors;
  }
  const critic: GenOutcome["critic"] = [];
  if (!draft) return { code: b.code, draft: null, errors, fixes, attempts, critic };

  // Критик: до criticRounds раундов; правка принимается, только если проходит проверку программой.
  let current: GenScenario = draftToGen(draft, set);
  let programErrors: string[] = [];
  for (let round = 1; round <= (opts.criticRounds ?? 0); round++) {
    const rc = await ask(
      messages,
      criticParams(b, set, current, draftFacts(b, set, draft), programErrors),
      usage,
    );
    if ("error" in rc) break;
    const c = parseCritic(rc.text);
    if (!c) break;
    if (c.verdict === "ok" && c.issues.length === 0) {
      critic.push({ round, verdict: "ok", issues: [], accepted: true });
      break;
    }
    const r = validateScenario(b, set, c.revised);
    critic.push({ round, verdict: c.verdict, issues: c.issues, accepted: r.draft !== null });
    if (r.draft) {
      draft = r.draft;
      fixes = r.fixes;
      current = draftToGen(draft, set);
      programErrors = [];
    } else programErrors = r.errors;
  }
  return { code: b.code, draft, errors: [], fixes, attempts, critic };
}

/** Пул: не больше concurrency запросов одновременно; порядок результатов — порядок заказов. */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (x: T, i: number) => Promise<R>,
) {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
