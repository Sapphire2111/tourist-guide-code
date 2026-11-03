// Промпт и схема ответа модели для одного сценария. Модель выбирает места ТОЛЬКО из списка кандидатов (ссылки p1…pN),
// пишет название, описание и примечания; длительность и сезон программа проверяет и поправляет сама (validate.ts).
import type Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./briefs.js";
import { candidateLine, type CandidateSet } from "./candidates.js";
import { DAY_ACTIVE_MAX_MIN, DAY_END, DAY_START, MODEL_TAGS, NOTE_ASK_MAX } from "./validate.js";

/**
 * Самая сильная модель (решение владельца 03.11.2026: качество важнее токенов) — Claude Opus 5.5 с адаптивным
 * размышлением (у Opus 5.5 оно всегда включено; глубина — effort).
 */
export const GEN_MODEL = "claude-opus-5-5";
export const GEN_EFFORT = "high" as const;
export type GenPrice = { input: number; cacheWrite: number; cacheRead: number; output: number };
/** $ за 1 млн токенов Opus 5.5 (обычные запросы): запись в кэш ×1,25, чтение ×0,05. Размышление — как вывод. */
export const GEN_USD_PER_MTOK: GenPrice = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };
/** Запасные модели server-side fallback (Opus 5, Opus 4.8): $5 / $25, запись в кэш ×1,25, чтение ×0,1. */
const FALLBACK_USD_PER_MTOK: GenPrice = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };
/** Цена модели, которая реально отработала попытку; другая модель — по старшей цене (сумма не занижается). */
export const priceOf = (model: string): GenPrice =>
  model === GEN_MODEL ? GEN_USD_PER_MTOK : FALLBACK_USD_PER_MTOK;
/**
 * Поток: размышление считается в max_tokens, а критик выводит сценарий целиком; 64 тыс. — по skill claude-api для
 * потоковых запросов (предел модели 128 тыс.). Лимит не стоит денег: оплачивается только то, что модель вывела.
 */
export const GEN_MAX_TOKENS = 64_000;
/** Зависший поток не держит место в пуле: по оценке SDK (128 тыс. токенов за час) 64 тыс. — около 30 мин. */
export const GEN_REQUEST_TIMEOUT_MS = 40 * 60_000;
/**
 * Скрытые повторы SDK (HTTP 408/409/429/5xx и обрыв связи до начала ответа): не оплачиваются токенами и не тратят
 * платные --retries; при 429 SDK ждёт retry-after. Обрыв уже идущего потока SDK не повторяет — это ошибка попытки.
 */
export const GEN_SDK_MAX_RETRIES = 4;
/**
 * Запасная модель при отказе (refusal) — на стороне API, по рекомендации skill claude-api для Opus 5.5
 * («default» выбирает модель по категории отказа).
 */
export const GEN_BETAS = ["server-side-fallback-2026-07-01"] as const;

/** Параметры запроса (beta: запасная модель при отказе). */
export type GenParams = Anthropic.Beta.Messages.MessageCreateParams;

/** Постоянный системный промпт — с кэшем (повторные запросы читают его из кэша). */
const cachedSystem = (text: string): GenParams["system"] => [
  { type: "text", text, cache_control: { type: "ephemeral" } },
];

const SEASON_UK: Record<string, string> = {
  winter: "зима",
  spring: "весна",
  summer: "літо",
  autumn: "осінь",
};

export const SYSTEM_PROMPT = `Ти — досвідчений місцевий гід Прикарпаття (Яремче, Микуличин, Татарів, Поляниця/Буковель, Ворохта, Яблуниця, Косів, Шешори, Маняв) і складаєш готові сценарії відпочинку «Мій план». Сценарій — план по днях: які місця відвідати, о котрій і скільки часу. Головне — реалістичний час, відмінний вибір місць і комфорт туриста: без поспіху, без «зигзагів», з їжею вчасно.

Суворі правила:
- Пункти — ЛИШЕ з наданого списку кандидатів, за посиланням (p1, p2…). Не вигадуй місць, назв, вершин, страв, цін, подій, яких немає у списку.
- Час на місці (minutes) — реалістичний. Якщо в кандидата «тривалість фіксована» — став саме її (похід на вершину — це весь день, а не 1–2 години). Інакше орієнтуйся на вказане «~N хв».
- Між пунктами — час на дорогу: авто ~35 км/год гірськими дорогами з серпантинами (+45% до відстані по прямій, +5 хв на паркування), пішки ~4,5 км/год. Наступний пункт починається не раніше, ніж закінчиться попередній плюс дорога. Порядок пунктів — логічний за географією, без повернень назад.
- Світловий день: усе надворі (походи, водоспади, оглядові, прогулянки) — до заходу сонця: зима ~16:15, весна ~18:30, літо ~20:15, осінь ~16:45; похід на вершину — закінчити щонайменше за 30 хв до заходу, з запасом на підйом і спуск.
- Обід — між 11:30 і 15:30, поруч з маршрутом. Після походу — відпочинок (вечеря, чан або SPA), а не нова активність.
- З дітьми — не більше однієї великої активності на день (від 2,5 год), короткі переїзди, ранній вечір.
- На Буковелі в сезон черги на підйомники — закладай час; місця з графіком не щодня (ринок у Косові — лише в суботу) — у назві чи примітці вкажи, у який день іти.
- Для кожного дня з пунктами надворі дай запасний варіант на дощ: хоча б одна альтернатива під дахом (музей, кафе, чан/SPA).
- Різноманітність: місця з позначкою «уже в N сценаріях» бери лише з вагомої причини, якщо є інші хороші варіанти. «ОБОВʼЯЗКОВИЙ ПУНКТ» — обовʼязково включи.
- День: ${DAY_START}–${DAY_END}, активного часу (сума тривалостей) не більше ${Math.round(DAY_ACTIVE_MAX_MIN / 60)} год. Один великий похід (від 4 год) — максимум один на день, старт до 10:00, і поруч з ним лише їжа та відпочинок.
- Враховуй графік роботи кандидата (якщо відомий): у цей час місце має бути відчинене. «?» — графік невідомий.
- Обід і вечеря — у закладах зі списку, поруч з попереднім пунктом. У кожному повному дні є щонайменше одне місце, де поїсти.
- Не повторюй місця в одному сценарії й не бери дві картки того самого місця (майже однакові координати чи назва, той самий маршрут). Альтернативи (0–3) — схожі місця зі списку для кнопки «Замінити».
- Сезон: зимою немає літніх походів на вершини; влітку немає лиж.
- Текст українською: назва до 60 символів, опис 1–2 речення (до 250 символів), примітка до пункту — коротка практична порада (що робити, взуття, бронювання, коли краще прийти; до ${NOTE_ASK_MAX} символів, лише закінчені речення: довший текст програма скоротить до останнього закінченого речення). Не описуй вигляд, обстановку, страви чи послуги місця, яких немає у списку (не пиши «просто неба», «з видом», «біля річки», якщо цього там нема). Без емодзі й реклами. Англійська назва — переклад.
- tags — лише з дозволених; days — рівно стільки днів, скільки просять.`;

export function userPrompt(b: Brief, set: CandidateSet, retryErrors: readonly string[] = []): string {
  const seasons = b.seasons.length ? b.seasons.map((s) => SEASON_UK[s]).join(", ") : "круглий рік";
  const lines = set.candidates.map(candidateLine).join("\n");
  const audience = [
    b.theme.kids ? "з дітьми (без барів, нічних клубів і довгих походів)" : null,
    b.theme.noCar ? "без авто — усе пішки, до 2 км між сусідніми пунктами" : null,
    b.theme.rain ? "дощ — усі пункти під дахом" : null,
  ].filter(Boolean);
  return [
    `Сценарій: ${b.theme.ask}`,
    `Район: ${b.area}; днів: ${b.days}; сезон: ${seasons}.`,
    audience.length ? `Аудиторія: ${audience.join("; ")}.` : null,
    `Дозволені теги: ${MODEL_TAGS.join(", ")}.`,
    "",
    "Кандидати (посилання | назва | категорія/тип | широта,довгота | що це й скільки часу | рейтинг Google | теги | графік):",
    lines,
    retryErrors.length
      ? `\nПопередня спроба не пройшла перевірку — виправ:\n${retryErrors.map((e) => `- ${e}`).join("\n")}`
      : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

/** Ответ модели (JSON по схеме). */
export type GenItem = {
  ref: string;
  time: string;
  minutes: number;
  note_uk: string;
  alternatives: string[];
};
export type GenScenario = {
  title_uk: string;
  title_en: string;
  description_uk: string;
  tags: string[];
  days: { day: number; items: GenItem[] }[];
};

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title_uk", "title_en", "description_uk", "tags", "days"],
  properties: {
    title_uk: { type: "string" },
    title_en: { type: "string" },
    description_uk: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: [...MODEL_TAGS] } },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["day", "items"],
        properties: {
          day: { type: "integer" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ref", "time", "minutes", "note_uk", "alternatives"],
              properties: {
                ref: { type: "string", description: "Посилання кандидата: p1, p2…" },
                time: { type: "string", description: "Початок, ГГ:ХХ" },
                minutes: { type: "integer" },
                note_uk: {
                  type: "string",
                  description: `Порада туристу: до ${NOTE_ASK_MAX} символів, лише закінчені речення`,
                },
                alternatives: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function requestParams(b: Brief, set: CandidateSet, retryErrors: readonly string[] = []): GenParams {
  return {
    model: GEN_MODEL,
    max_tokens: GEN_MAX_TOKENS,
    // Адаптивное размышление (у Opus 5.5 включено всегда), высокое усилие — качество плана важнее токенов.
    thinking: { type: "adaptive" },
    output_config: { effort: GEN_EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: cachedSystem(SYSTEM_PROMPT),
    messages: [{ role: "user", content: userPrompt(b, set, retryErrors) }],
    betas: [...GEN_BETAS],
    fallbacks: "default",
  };
}

// --- критик: второй проход «как опытный местный гид» ---

export const CRITIC_SYSTEM = `Ти — прискіпливий досвідчений місцевий гід Прикарпаття. Тобі дають чернетку сценарію «Мій план», список кандидатів (лише з них можна брати місця) і розрахунки програми (час дороги, захід сонця). Перевір чернетку так, ніби завтра ведеш за нею туристів:
- реалістичність часу на місцях і в дорозі (гірські дороги, серпантини, паркування, черги на підйомники в сезон), запас на підйом і спуск у походах;
- логістика й географія: порядок без «зигзагів» і повернень, переїзди короткі;
- втома: не більше однієї великої активності, після походу — відпочинок; з дітьми — ще мʼякше;
- їжа: обід вчасно (11:30–15:30) і поруч з маршрутом, вечеря; туалет і паркування — у примітках, якщо доречно;
- світловий день і сезон: усе надворі — до заходу сонця; зимою — без літніх походів;
- погода: для днів надворі — запасний варіант під дахом серед альтернатив;
- графік роботи й дні закриття (місця не щодня — вказати день);
- якість вибору: найкращі місця для теми, без кількох карток того самого місця, без зайвих повторів популярних місць.
Якщо все добре — verdict "ok", issues порожній, revised — без змін. Якщо є що покращити — verdict "fix", issues — коротко що не так, revised — виправлений сценарій повністю (за тими ж правилами: лише кандидати p1…pN, той самий формат). Примітка до пункту — до ${NOTE_ASK_MAX} символів, лише закінчені речення: довший текст програма скоротить до останнього закінченого речення, тому не дописуй примітки понад цю межу. Не вигадуй фактів про місця.`;

export type CriticResult = { verdict: "ok" | "fix"; issues: string[]; revised: GenScenario };

export const CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "revised"],
  properties: {
    verdict: { type: "string", enum: ["ok", "fix"] },
    issues: { type: "array", items: { type: "string" } },
    revised: OUTPUT_SCHEMA,
  },
} as const;

/** Изменяемая часть запроса критика: расчёты программы, ошибки прошлой правки, JSON чернетки. */
export function criticTail(
  draft: GenScenario,
  facts: readonly string[],
  programErrors: readonly string[] = [],
): string {
  const parts = [
    "",
    "Розрахунки програми для чернетки (дорога гірськими дорогами, захід сонця):",
    ...facts.map((f) => `- ${f}`),
  ];
  if (programErrors.length)
    parts.push(
      "",
      "Попереднє виправлення не пройшло перевірку програмою — врахуй:",
      ...programErrors.map((e) => `- ${e}`),
    );
  parts.push("", "Чернетка (JSON):", JSON.stringify(draft));
  return parts.join("\n");
}

export function criticParams(
  b: Brief,
  set: CandidateSet,
  draft: GenScenario,
  facts: readonly string[],
  programErrors: readonly string[] = [],
): GenParams {
  return {
    model: GEN_MODEL,
    max_tokens: GEN_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: GEN_EFFORT, format: { type: "json_schema", schema: CRITIC_SCHEMA } },
    system: cachedSystem(CRITIC_SYSTEM),
    // Постановка и кандидаты одинаковы во всех раундах критика — кэшируются; меняется только хвост с чернеткой.
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt(b, set), cache_control: { type: "ephemeral" } },
          { type: "text", text: criticTail(draft, facts, programErrors) },
        ],
      },
    ],
    betas: [...GEN_BETAS],
    fallbacks: "default",
  };
}

export function parseCritic(text: string): CriticResult | null {
  try {
    const v = JSON.parse(text) as Partial<CriticResult>;
    const revised = parseScenario(JSON.stringify(v.revised ?? null));
    if ((v.verdict !== "ok" && v.verdict !== "fix") || !revised) return null;
    return {
      verdict: v.verdict,
      issues: Array.isArray(v.issues) ? v.issues.filter((x): x is string => typeof x === "string") : [],
      revised,
    };
  } catch {
    return null;
  }
}

/** JSON ответа модели или null (не JSON, не та форма). */
export function parseScenario(text: string): GenScenario | null {
  try {
    const v = JSON.parse(text) as Partial<GenScenario>;
    if (typeof v.title_uk !== "string" || !Array.isArray(v.days)) return null;
    return {
      title_uk: v.title_uk,
      title_en: typeof v.title_en === "string" ? v.title_en : "",
      description_uk: typeof v.description_uk === "string" ? v.description_uk : "",
      tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string") : [],
      days: v.days,
    };
  } catch {
    return null;
  }
}
