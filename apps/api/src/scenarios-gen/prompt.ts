// Промпт и схема ответа модели для одного сценария. Модель выбирает места ТОЛЬКО из списка кандидатов (ссылки p1…pN),
// пишет название, описание и примечания; длительность и сезон программа проверяет и поправляет сама (validate.ts).
import type Anthropic from "@anthropic-ai/sdk";
import type { Brief } from "./briefs.js";
import { candidateLine, type CandidateSet } from "./candidates.js";
import { DAY_ACTIVE_MAX_MIN, DAY_END, DAY_START, MODEL_TAGS } from "./validate.js";

/** Последняя Claude Sonnet (как places:enrich). */
export const GEN_MODEL = "claude-sonnet-5-5";
/** $ за 1 млн токенов (обычные запросы; Message Batches — вдвое дешевле): запись в кэш ×1,25, чтение ×0,1. */
export const GEN_USD_PER_MTOK = { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } as const;
export const GEN_MAX_TOKENS = 16_000;

const SEASON_UK: Record<string, string> = {
  winter: "зима",
  spring: "весна",
  summer: "літо",
  autumn: "осінь",
};

export const SYSTEM_PROMPT = `Ти складаєш готові сценарії відпочинку «Мій план» для туристів у Карпатах (Прикарпаття: Яремче, Микуличин, Татарів, Поляниця/Буковель, Ворохта, Яблуниця). Сценарій — план по днях: які місця відвідати, о котрій і скільки часу.

Суворі правила:
- Пункти — ЛИШЕ з наданого списку кандидатів, за посиланням (p1, p2…). Не вигадуй місць, назв, вершин, страв, цін, подій, яких немає у списку.
- Час на місці (minutes) — реалістичний. Якщо в кандидата «тривалість фіксована» — став саме її (похід на вершину — це весь день, а не 1–2 години). Інакше орієнтуйся на вказане «~N хв».
- Між пунктами — час на дорогу: авто ~35 км/год гірськими дорогами (+30% до відстані по прямій), пішки ~4,5 км/год. Наступний пункт починається не раніше, ніж закінчиться попередній плюс дорога.
- День: ${DAY_START}–${DAY_END}, активного часу (сума тривалостей) не більше ${Math.round(DAY_ACTIVE_MAX_MIN / 60)} год. Один великий похід (від 4 год) — максимум один на день, старт до 10:00, і поруч з ним лише їжа та відпочинок.
- Враховуй графік роботи кандидата (якщо відомий): у цей час місце має бути відчинене. «?» — графік невідомий.
- Обід і вечеря — у закладах зі списку, поруч з попереднім пунктом. У кожному повному дні є щонайменше одне місце, де поїсти.
- Не повторюй місця в одному сценарії й не бери дві картки того самого місця (майже однакові координати чи назва, той самий маршрут). Альтернативи (0–3) — схожі місця зі списку для кнопки «Замінити».
- Сезон: зимою немає літніх походів на вершини; влітку немає лиж.
- Текст українською: назва до 60 символів, опис 1–2 речення (до 250 символів), примітка до пункту — коротка практична порада (що робити, взуття, бронювання, коли краще прийти; до 140 символів). Не описуй вигляд, обстановку, страви чи послуги місця, яких немає у списку (не пиши «просто неба», «з видом», «біля річки», якщо цього там нема). Без емодзі й реклами. Англійська назва — переклад.
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
                note_uk: { type: "string" },
                alternatives: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function requestParams(
  b: Brief,
  set: CandidateSet,
  retryErrors: readonly string[] = [],
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: GEN_MODEL,
    max_tokens: GEN_MAX_TOKENS,
    // Подбор из готового списка по правилам: низкое усилие — дешевле, качество проверяет программа.
    output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt(b, set, retryErrors) }],
  };
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
