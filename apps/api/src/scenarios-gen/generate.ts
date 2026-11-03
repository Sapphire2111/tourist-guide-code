// Генерация сценариев: заказ → кандидаты → запрос к модели (структурированный JSON) → проверка программой; не прошёл —
// ещё попытка с перечнем ошибок. Затем «критик» (второй проход модели как опытного местного гида: реализм времени,
// логистика, усталость, еда, световой день, погода) — до N раундов; каждая правка критика снова проходит проверку
// программой, не прошла — критик получает ошибки. Ключ — ANTHROPIC_API_KEY из env (SDK читает сам), в логи не попадает.
import type Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./briefs.js";
import type { CandidateSet } from "./candidates.js";
import {
  criticParams,
  GEN_REQUEST_TIMEOUT_MS,
  parseCritic,
  parseScenario,
  priceOf,
  requestParams,
  type GenParams,
  type GenScenario,
} from "./prompt.js";
import {
  draftFacts,
  draftToGen,
  validateScenario,
  type ScenarioDraft,
  type ValidationResult,
} from "./validate.js";

/** Часть клиента Anthropic, нужная генератору (подменяется в тестах). */
export type MessagesApi = Pick<Anthropic["beta"]["messages"], "stream">;

/** Токены: input — без кэша; cacheWrite/cacheRead — запись и чтение кэша промпта (цены разные). */
export type Usage = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Запросы с итоговым ответом модели. */
  requests: number;
  /** Сумма, $ (без округления): каждая попытка — по ценам модели, которая её отработала. */
  costUsd: number;
  /** Запросы без итогового ответа (ошибка API, обрыв). */
  failedRequests: number;
  /** Из них оборвались уже на потоке: вывод до обрыва неизвестен, сумма занижена. */
  interrupted: number;
  /** Отказ всей цепочки моделей. */
  refusals: number;
  /** stop_reason=max_tokens: генерация и критик отдельно. */
  maxTokensGen: number;
  maxTokensCritic: number;
  /** Ответов, которые отдала запасная модель (fallback_message в usage.iterations). */
  fallbacks: number;
  /** Какая модель сколько ответов отдала (фактическая, res.model). */
  servedBy: Record<string, number>;
};
export const emptyUsage = (): Usage => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  requests: 0,
  costUsd: 0,
  failedRequests: 0,
  interrupted: 0,
  refusals: 0,
  maxTokensGen: 0,
  maxTokensCritic: 0,
  fallbacks: 0,
  servedBy: {},
});

export function addUsage(to: Usage, u: Usage): void {
  to.input += u.input;
  to.cacheWrite += u.cacheWrite;
  to.cacheRead += u.cacheRead;
  to.output += u.output;
  to.requests += u.requests;
  to.costUsd += u.costUsd;
  to.failedRequests += u.failedRequests;
  to.interrupted += u.interrupted;
  to.refusals += u.refusals;
  to.maxTokensGen += u.maxTokensGen;
  to.maxTokensCritic += u.maxTokensCritic;
  to.fallbacks += u.fallbacks;
  for (const [m, n] of Object.entries(u.servedBy)) to.servedBy[m] = (to.servedBy[m] ?? 0) + n;
}

/** Критик: verdict "error" — раунд сорвался (max_tokens, отказ, неразборчивый ответ), черновик остался прежним. */
export type CriticRound = { round: number; verdict: string; issues: string[]; accepted: boolean };

export type GenOutcome = {
  code: string;
  draft: ScenarioDraft | null;
  /** Ошибки последней попытки (draft null — сценарий отброшен). */
  errors: string[];
  fixes: string[];
  attempts: number;
  /** Замечания критика по раундам (что исправлено). */
  critic: CriticRound[];
  /** Модель, чей ответ стал итоговым черновиком (может быть запасной), null — черновика нет. */
  model: string | null;
};

export const usd = (u: Pick<Usage, "costUsd">) => Math.round(u.costUsd * 100) / 100;

/** Стоимость токенов по ценам модели, $. */
export function tokensCost(
  model: string,
  t: { input: number; cacheWrite: number; cacheRead: number; output: number },
): number {
  const p = priceOf(model);
  return (
    (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6
  );
}

type ApiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

function addTokens(usage: Usage, model: string, u: ApiUsage): void {
  const t = {
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  usage.input += t.input;
  usage.cacheWrite += t.cacheWrite;
  usage.cacheRead += t.cacheRead;
  usage.output += t.output;
  usage.costUsd += tokensCost(model, t);
}

/**
 * Токены ответа. usage.iterations — запись по каждой попытке (отклонённая + запасная), верхний usage описывает лишь
 * попытку, давшую ответ. Отказ до вывода оплачивается не всегда (зависит от категории), но считаем и его: лимит
 * расходов не должен срабатывать поздно.
 */
function addMessage(usage: Usage, res: Anthropic.Beta.Messages.BetaMessage, requested: string): void {
  const served = res.model ?? requested;
  usage.requests++;
  usage.servedBy[served] = (usage.servedBy[served] ?? 0) + 1;
  const iterations = res.usage.iterations ?? [];
  if (iterations.some((i) => i.type === "fallback_message")) usage.fallbacks++;
  if (!iterations.length) return addTokens(usage, served, res.usage);
  for (const i of iterations) addTokens(usage, ("model" in i ? i.model : null) ?? served, i);
}

/**
 * Текст ответа. На потоке при отказе посреди вывода запасная модель продолжает частичный текст: сначала склейка всех
 * блоков. Если склейка не JSON, а запасная модель ответила заново, — текст после последнего блока fallback.
 */
export function answerText(content: readonly Anthropic.Beta.Messages.BetaContentBlock[]): string {
  const textOf = (blocks: readonly Anthropic.Beta.Messages.BetaContentBlock[]) =>
    blocks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  const all = textOf(content);
  const lastFallback = content.map((c) => c.type).lastIndexOf("fallback");
  if (lastFallback < 0 || isJson(all)) return all;
  const tail = textOf(content.slice(lastFallback + 1));
  return isJson(tail) ? tail : all;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Запрос к модели (поток, итог — finalMessage): текст ответа и фактическая модель или причина отказа; токены — в usage. */
async function ask(
  messages: MessagesApi,
  params: GenParams,
  usage: Usage,
  role: "gen" | "critic",
): Promise<{ text: string; model: string } | { error: string }> {
  let stream: ReturnType<MessagesApi["stream"]> | undefined;
  try {
    stream = messages.stream(params, { signal: AbortSignal.timeout(GEN_REQUEST_TIMEOUT_MS) });
    const res = await stream.finalMessage();
    addMessage(usage, res, params.model);
    if (res.stop_reason === "refusal") {
      usage.refusals++;
      return { error: `модель зупинилась: refusal (${res.stop_details?.category ?? "без категорії"})` };
    }
    if (res.stop_reason === "max_tokens") {
      if (role === "gen") usage.maxTokensGen++;
      else usage.maxTokensCritic++;
      return { error: "модель зупинилась: max_tokens" };
    }
    return { text: answerText(res.content), model: res.model ?? params.model };
  } catch (err) {
    usage.failedRequests++;
    // Поток успел начаться: вход известен из message_start, вывод — нет (его итог приходит в конце потока).
    const partial = stream?.currentMessage;
    if (partial) {
      usage.interrupted++;
      addTokens(usage, partial.model ?? params.model, partial.usage);
    }
    return { error: `запит не вдався: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Проверка программой; ответ не той формы (падение проверки) — обычная ошибка попытки, а не потеря заказа. */
function validated(b: Brief, set: CandidateSet, gen: GenScenario): ValidationResult {
  try {
    return validateScenario(b, set, gen);
  } catch (err) {
    return {
      draft: null,
      errors: [`відповідь не за схемою: ${err instanceof Error ? err.message : String(err)}`],
      fixes: [],
    };
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
  let model: string | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= opts.retries + 1 && !draft; attempt++) {
    attempts = attempt;
    const r0 = await ask(messages, requestParams(b, set, errors), usage, "gen");
    if ("error" in r0) {
      errors = [r0.error];
      continue;
    }
    const gen = parseScenario(r0.text);
    if (!gen) {
      errors = ["відповідь не JSON за схемою"];
      continue;
    }
    const r = validated(b, set, gen);
    fixes = r.fixes;
    draft = r.draft;
    errors = r.errors;
    if (draft) model = r0.model;
  }
  const critic: CriticRound[] = [];
  if (!draft) return { code: b.code, draft: null, errors, fixes, attempts, critic, model: null };

  // Критик: до criticRounds раундов; правка принимается, только если проходит проверку программой.
  let current: GenScenario = draftToGen(draft, set);
  let programErrors: string[] = [];
  for (let round = 1; round <= (opts.criticRounds ?? 0); round++) {
    const rc = await ask(
      messages,
      criticParams(b, set, current, draftFacts(b, set, draft), programErrors),
      usage,
      "critic",
    );
    if ("error" in rc) {
      critic.push({ round, verdict: "error", issues: [rc.error], accepted: false });
      break;
    }
    const c = parseCritic(rc.text);
    if (!c) {
      critic.push({ round, verdict: "error", issues: ["відповідь не JSON за схемою"], accepted: false });
      break;
    }
    if (c.verdict === "ok" && c.issues.length === 0) {
      critic.push({ round, verdict: "ok", issues: [], accepted: true });
      break;
    }
    const r = validated(b, set, c.revised);
    critic.push({ round, verdict: c.verdict, issues: c.issues, accepted: r.draft !== null });
    if (r.draft) {
      draft = r.draft;
      model = rc.model;
      fixes = r.fixes;
      current = draftToGen(draft, set);
      programErrors = [];
    } else programErrors = r.errors;
  }
  return { code: b.code, draft, errors: [], fixes, attempts, critic, model };
}

/**
 * Пул: не больше concurrency запросов одновременно; порядок результатов — порядок заказов. shouldStop проверяется
 * перед каждым новым заказом: уже идущие дорабатывают, не начатые остаются undefined.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (x: T, i: number) => Promise<R>,
  shouldStop?: () => boolean,
) {
  const out = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop?.()) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}
