// Генерация сценариев: заказ → кандидаты → запрос к модели (структурированный JSON) → проверка программой; не прошёл —
// ещё попытка с перечнем ошибок. Ключ — ANTHROPIC_API_KEY из env (SDK читает сам), в логи не попадает.
import type Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./briefs.js";
import type { CandidateSet } from "./candidates.js";
import { GEN_USD_PER_MTOK, parseScenario, requestParams } from "./prompt.js";
import { validateScenario, type ScenarioDraft } from "./validate.js";

/** Часть клиента Anthropic, нужная генератору (подменяется в тестах). */
export type MessagesApi = Pick<Anthropic["messages"], "create">;

export type Usage = { input: number; output: number; requests: number };

export type GenOutcome = {
  code: string;
  draft: ScenarioDraft | null;
  /** Ошибки последней попытки (draft null — сценарий отброшен). */
  errors: string[];
  fixes: string[];
  attempts: number;
};

export const usd = (u: Usage, discount = 1) =>
  Math.round(
    ((u.input * GEN_USD_PER_MTOK.input + u.output * GEN_USD_PER_MTOK.output) / 1e6) * discount * 100,
  ) / 100;

export async function generateOne(
  messages: MessagesApi,
  b: Brief,
  set: CandidateSet,
  usage: Usage,
  opts: { retries: number },
): Promise<GenOutcome> {
  let errors: string[] = [];
  let fixes: string[] = [];
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    let text = "";
    try {
      const res = await messages.create(requestParams(b, set, errors));
      usage.requests++;
      usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0);
      usage.output += res.usage.output_tokens;
      if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
        errors = [`модель зупинилась: ${res.stop_reason}`];
        continue;
      }
      text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    } catch (err) {
      errors = [`запит не вдався: ${err instanceof Error ? err.message : String(err)}`];
      continue;
    }
    const gen = parseScenario(text);
    if (!gen) {
      errors = ["відповідь не JSON за схемою"];
      continue;
    }
    const r = validateScenario(b, set, gen);
    fixes = r.fixes;
    if (r.draft) return { code: b.code, draft: r.draft, errors: [], fixes, attempts: attempt };
    errors = r.errors;
  }
  return { code: b.code, draft: null, errors, fixes, attempts: opts.retries + 1 };
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
