// Удобства мест проживания («Де жити», CLI places:amenities): структурированные удобства Google (надёжно) плюс
// извлечение моделью из отзывов и описания Google — только удобства НА ТЕРРИТОРИИ, прямо подтверждённые текстом, с
// цитатой-доказательством. Программа перепроверяет каждый ответ: цитата должна дословно быть в тексте Google,
// содержать ключевое слово удобства и не содержать отрицания («басейну немає») или «поруч» («басейн неподалік»).
// Ничего не выдумываем: нет подтверждения — нет тега (правило проекта: данные мест — только из Google).
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { PlaceEnrichmentGoogle } from "../db/index.js";
import { AI_MODEL } from "../places-enrich/ai.js";

export const AMENITY_CODES = [
  "pool",
  "sauna",
  "hot_tub",
  "breakfast",
  "parking",
  "pets",
  "kids",
  "wifi",
  "kitchen",
] as const;
export type AmenityCode = (typeof AMENITY_CODES)[number];

const isAmenity = (v: unknown): v is AmenityCode => AMENITY_CODES.includes(v as AmenityCode);

/** Код удобства → код тега каталога (tags.code, is_catalog_code: без подчёркивания в начале/конце). */
export const AMENITY_TAG: Readonly<Record<AmenityCode, string>> = {
  pool: "pool",
  sauna: "sauna",
  hot_tub: "hot-tub",
  breakfast: "breakfast",
  parking: "parking",
  pets: "pets",
  kids: "kids",
  wifi: "wifi",
  kitchen: "kitchen",
};

/** Теги, которые CLI создаёт в регионе, если их нет (kids, pets, parking, wifi — уже в SEED_TAGS). */
export const AMENITY_TAG_DEFS: readonly {
  code: string;
  name: { uk: string; en: string };
  group: "amenity" | "audience";
  sortOrder: number;
}[] = [
  { code: "kids", name: { uk: "З дітьми", en: "Kids friendly" }, group: "audience", sortOrder: 0 },
  { code: "pets", name: { uk: "З тваринами", en: "Pets allowed" }, group: "audience", sortOrder: 10 },
  { code: "parking", name: { uk: "Паркування", en: "Parking" }, group: "amenity", sortOrder: 20 },
  { code: "wifi", name: { uk: "Wi-Fi", en: "Wi-Fi" }, group: "amenity", sortOrder: 30 },
  { code: "pool", name: { uk: "Басейн", en: "Swimming pool" }, group: "amenity", sortOrder: 100 },
  { code: "sauna", name: { uk: "Сауна / баня", en: "Sauna" }, group: "amenity", sortOrder: 110 },
  { code: "hot-tub", name: { uk: "Чан / джакузі", en: "Hot tub" }, group: "amenity", sortOrder: 120 },
  { code: "breakfast", name: { uk: "Сніданок", en: "Breakfast" }, group: "amenity", sortOrder: 130 },
  {
    code: "kitchen",
    name: { uk: "Кухня для гостей", en: "Guest kitchen" },
    group: "amenity",
    sortOrder: 140,
  },
];

/** Структурированные удобства Google (place_enrichments.google.amenities) → удобство. */
const STRUCTURED: Readonly<Record<string, AmenityCode>> = {
  good_for_children: "kids",
  dogs_allowed: "pets",
  parking_free: "parking",
  parking_paid: "parking",
  breakfast: "breakfast",
};

export function structuredAmenities(amenities: readonly string[]): AmenityCode[] {
  const out = new Set<AmenityCode>();
  for (const a of amenities) {
    const code = STRUCTURED[a];
    if (code) out.add(code);
  }
  return AMENITY_CODES.filter((c) => out.has(c));
}

/**
 * Ключевые слова удобства (uk/ru/en; отзывы Google бывают на разных языках). Отбор текстов для модели и обязательное
 * условие цитаты: в доказательстве должно быть слово своего удобства.
 */
export const KEYWORDS: Readonly<Record<AmenityCode, RegExp>> = {
  pool: /басейн|бассейн|басеін|(?<!\p{L})pools?(?!\p{L})/iu,
  sauna: /саун|(?<!\p{L})бан(я|і|ю|ею|ька|ьки|ьку|ей|и)(?!\p{L})|лазн|хамам|хаммам|sauna|(?<!\p{L})banya/iu,
  hot_tub: /(?<!\p{L})чан(а|у|ом|и|ів|ах|ами|ов|і)?(?!\p{L})|джакуз|jacuzzi|hot[\s-]?tub/iu,
  breakfast: /сніда|завтрак|breakfast/iu,
  parking: /парков|паркуван|паркінг|паркинг|паркомісц|паркомест|машиномісц|машиномест|стоянк|parking/iu,
  pets: /собак|собач|(?<!\p{L})(пес|пса|псом|псів|кіт|кот|кота|котом|котик\p{L}*)(?!\p{L})|тварин|животн|(?<!\p{L})(pets?|dogs?)(?!\p{L})/iu,
  kids: /діт|дитя|дитин|дитяч|(?<!\p{L})дет(и|ей|ям|ьми)(?!\p{L})|детск|ребен|ребён|малеч|малюк|(?<!\p{L})kids?(?!\p{L})|child|famil/iu,
  wifi: /wi[\s-]?fi|вай[\s-]?фай|інтернет|интернет|internet/iu,
  kitchen: /кухн|kitchen|кухон|(?<!\p{L})плит(а|ою|у|и|ка|кою|ку|ки)(?!\p{L})|холодильн/iu,
};

/** Отрицание в цитате — удобства нет («басейну немає», «сніданків не було», «no breakfast»). */
export const NEGATION =
  /не\s*ма(є|е)|(?<!\p{L})нема(?!\p{L})|(?<!\p{L})не\s+(було|буде|працю\p{L}*|функціон\p{L}*|работа\p{L}*|было|будет|входить|входят|включ\p{L}*)(?!\p{L})|відсутн|отсутств|(?<!\p{L})нет(?!\p{L})|(?<!\p{L})(not|without|no)(?!\p{L})|зачинен/iu;
/** Запрет рядом со словом удобства (в любом порядке): «з тваринами не можна», «собак не приймають», «заборонено». */
const BAN = String.raw`(?:не\s+можна|нельзя|(?<!\p{L})заборон\p{L}*|(?<!\p{L})запрещ\p{L}*|не\s+(?:прийма|принима|дозвол|разреш|допуска|пуска)\p{L}*)`;
/** До двух слов между запретом и словом удобства. */
const GAP = String.raw`(?:\s+[\p{L}'’ʼ-]+){0,2}\s+`;

/**
 * Отрицание, привязанное к удобству: «без» — только прямо перед словом удобства («без сніданку», «номери без кухні»),
 * а «сніданок без додаткової оплати», «Wi-Fi без проблем» проходят; запреты — до или после слова удобства.
 */
export function negatedNear(code: AmenityCode, quote: string): boolean {
  const k = `(?:${KEYWORDS[code].source})`;
  return [
    new RegExp(String.raw`(?<!\p{L})(?:без|без\s+жодн\p{L}*|${BAN})${GAP}${k}`, "iu"),
    new RegExp(String.raw`(?<!\p{L})без\s+${k}`, "iu"),
    new RegExp(String.raw`${k}\p{L}*${GAP}${BAN}`, "iu"),
    new RegExp(String.raw`${k}\p{L}*\s+${BAN}`, "iu"),
  ].some((re) => re.test(quote));
}

/** «Поруч», а не на території («басейн неподалік», «паркінг через дорогу», «за 200 м сауна»). */
export const NEARBY =
  /поруч|поряд|неподалік|неподалеку|недалеко|рядом|по\s*сусідству|сусідн|соседн|через\s+дорогу|напроти|напротив|(?<!\p{L})near(by)?(?!\p{L})|за\s+\d+\s*(м|км|хв|мин|метр\p{L}*)(?!\p{L})|(?<!\p{L})[ву]\s+(центрі|місті|селі|селищі)(?!\p{L})/iu;

/** «Кухня» про страви ресторану («смачна кухня»), а не кухня для гостей. */
export const CUISINE =
  /смачн|вкусн|кухар|повар|страв|блюд|меню|ресторан|домашн\p{L}* кухн|гуцульськ\p{L}* кухн|кухня\s+(чудова|супер|відмінна|прекрасна|хороша|топ)/iu;

export type Source = { label: string; text: string };

/** Отзыв короче — не несёт информации; длиннее — режется (стоимость). */
const SOURCE_MAX_CHARS = 1500;

/**
 * Тексты Google для модели: описание и отзывы, где есть ключевые слова хотя бы одного удобства (остальные не дают
 * доказательств, только стоят денег). hits — удобства, чьи слова встретились (пусто — модель не вызывается).
 */
export function relevantSources(google: Pick<PlaceEnrichmentGoogle, "summary" | "reviews"> | null): {
  sources: Source[];
  hits: AmenityCode[];
} {
  const sources: Source[] = [];
  const hits = new Set<AmenityCode>();
  const consider = (label: string, raw: string | null | undefined) => {
    const text = raw?.replace(/\s+/g, " ").trim().slice(0, SOURCE_MAX_CHARS);
    if (!text) return;
    const found = AMENITY_CODES.filter((c) => KEYWORDS[c].test(text));
    if (!found.length) return;
    for (const c of found) hits.add(c);
    sources.push({ label, text });
  };
  consider("опис Google", google?.summary);
  for (const [i, r] of (google?.reviews ?? []).entries()) consider(`відгук ${i + 1}`, r.text);
  return { sources, hits: AMENITY_CODES.filter((c) => hits.has(c)) };
}

// --- модель ---

export { AI_MODEL as AMENITIES_MODEL };
/** Версия промпта: меняется — места извлекаются заново (входит в хэш входа). */
export const AMENITIES_PROMPT_VERSION = "2";
const MAX_TOKENS = 3000;
/** Цитата длиннее — обрезанный пересказ, а не цитата. */
export const EVIDENCE_MAX_CHARS = 300;

/** $ за 1 млн токенов claude-sonnet-5-5 (обычные запросы, как AI_BATCH_USD_PER_MTOK ×2): кэш — запись ×1,25, чтение ×0,1. */
export const AMENITIES_USD_PER_MTOK = { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } as const;

export const SYSTEM_PROMPT = `Ти перевіряєш, які зручності є НА ТЕРИТОРІЇ місця проживання (готель, садиба, котедж) у Карпатах.
Вхід — тексти з Google Maps: опис Google і відгуки гостей. Інших знань про місце не використовуй, нічого не вигадуй.

Коди зручностей:
- pool — басейн (відкритий або критий) на території;
- sauna — сауна, баня, лазня, хамам на території;
- hot_tub — чан (гуцульський чан, купіль з підігрівом) або джакузі / гідромасажна ванна;
- breakfast — сніданок для гостей (включений або за доплату, в закладі);
- parking — паркування / стоянка для авто гостей на території або закріплене за закладом;
- pets — гостям можна з власними тваринами (гості приїжджали з собакою/котом, або прямо написано, що можна).
  Місцеві тварини господарів, коти й собаки, що живуть на подвір'ї, контактний зоопарк — НЕ pets;
- kids — підходить для дітей: гості відпочивали з дітьми і це вдалося, або є дитячий майданчик, дитяча кімната, ліжечко;
- wifi — Wi-Fi / інтернет для гостей;
- kitchen — кухня для гостей (самостійно готувати: кухня в номері/будиночку, спільна кухня, плита, посуд). Ресторанна «смачна кухня» — НЕ kitchen.

Правила:
1. Познач зручність, лише коли текст ПРЯМО підтверджує, що вона є саме в цьому місці.
2. НЕ познач, якщо є заперечення («басейну немає», «сніданки не входять», «Wi-Fi не працював»), якщо це лише бажання
   чи порада («було б добре мати сауну»), якщо зручність поруч чи деінде («басейн у сусідньому готелі», «чан неподалік»,
   «паркування на вулиці біля дороги»), якщо неясно, про яке місце мова.
3. Для кожної позначеної зручності дай evidence — ДОСЛІВНУ цитату (5–200 символів) з одного тексту, без змін, без «…».
   Цитата має містити саму назву зручності (басейн, сауна, чан, сніданок, парковка, собака, діти, Wi-Fi, кухня).
4. Кожен код — щонайбільше один раз. Немає підтверджених — порожній список.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    amenities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string", enum: [...AMENITY_CODES] },
          evidence: { type: "string" },
        },
        required: ["code", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["amenities"],
  additionalProperties: false,
} as const;

export function userPrompt(name: string, sources: readonly Source[]): string {
  return [`Місце: ${name}`, "", ...sources.map((s) => `[${s.label}] ${s.text}`)].join("\n");
}

export function requestParams(
  name: string,
  sources: readonly Source[],
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: AI_MODEL,
    max_tokens: MAX_TOKENS,
    // Извлечение по коротким текстам: низкое усилие достаточно, ответ — по схеме JSON.
    output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt(name, sources) }],
  };
}

/** Хэш входа: модель, версия промпта и тексты — изменились отзывы или промпт, место извлекается заново. */
export function inputHash(sources: readonly Source[]): string {
  return createHash("sha256")
    .update(`${AI_MODEL}|${AMENITIES_PROMPT_VERSION}|${JSON.stringify(sources)}`)
    .digest("hex")
    .slice(0, 32);
}

// --- проверка ответа ---

export type Finding = { code: AmenityCode; evidence: string };
export type RejectReason =
  | "unknown_code"
  | "empty"
  | "too_long"
  | "not_in_source"
  | "no_keyword"
  | "negation"
  | "nearby"
  | "cuisine"
  | "duplicate";
export type Rejected = { code: string; evidence: string; reason: RejectReason };

/** Сравнение цитаты с текстом: регистр, пробелы, апострофы и кавычки не важны. */
export function normalizeQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'ʼ‘`]/g, "'")
    .replace(/[«»“”„"]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Проверка одной находки модели против текстов Google; null — принята. */
export function checkFinding(
  code: string,
  evidence: string,
  sources: readonly Source[],
): RejectReason | null {
  if (!isAmenity(code)) return "unknown_code";
  const quote = normalizeQuote(evidence.replace(/^[.…\s"'«»{}[\]]+|[.…\s"'«»{}[\]]+$/g, ""));
  if (quote.length < 3) return "empty";
  if (quote.length > EVIDENCE_MAX_CHARS) return "too_long";
  if (!sources.some((s) => normalizeQuote(s.text).includes(quote))) return "not_in_source";
  if (!KEYWORDS[code].test(quote)) return "no_keyword";
  if (NEGATION.test(quote) || negatedNear(code, quote)) return "negation";
  if (NEARBY.test(quote)) return "nearby";
  if (code === "kitchen" && CUISINE.test(quote)) return "cuisine";
  return null;
}

export class ExtractionParseError extends Error {}

/** Ответ модели (JSON по схеме) → принятые и отклонённые находки. Неразборчивый ответ — ExtractionParseError. */
export function parseExtraction(
  text: string,
  sources: readonly Source[],
): { accepted: Finding[]; rejected: Rejected[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ExtractionParseError("ответ не JSON");
  }
  const list = (data as { amenities?: unknown } | null)?.amenities;
  if (!Array.isArray(list)) throw new ExtractionParseError("нет массива amenities");
  const accepted: Finding[] = [];
  const rejected: Rejected[] = [];
  for (const item of list) {
    const code = String((item as { code?: unknown } | null)?.code ?? "");
    const evidence = String((item as { evidence?: unknown } | null)?.evidence ?? "").trim();
    let reason = checkFinding(code, evidence, sources);
    if (!reason && accepted.some((a) => a.code === code)) reason = "duplicate";
    if (reason) rejected.push({ code, evidence, reason });
    else accepted.push({ code: code as AmenityCode, evidence });
  }
  accepted.sort((a, b) => AMENITY_CODES.indexOf(a.code) - AMENITY_CODES.indexOf(b.code));
  return { accepted, rejected };
}

// --- токены и деньги ---

export type AmenitiesUsage = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  requests: number;
  costUsd: number;
};
export const emptyAmenitiesUsage = (): AmenitiesUsage => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  requests: 0,
  costUsd: 0,
});

export function addApiUsage(
  to: AmenitiesUsage,
  u: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): void {
  const p = AMENITIES_USD_PER_MTOK;
  const t = {
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  to.input += t.input;
  to.cacheWrite += t.cacheWrite;
  to.cacheRead += t.cacheRead;
  to.output += t.output;
  to.requests += 1;
  to.costUsd +=
    (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
}

export function sumUsage(list: readonly AmenitiesUsage[]): AmenitiesUsage {
  const total = emptyAmenitiesUsage();
  for (const u of list) {
    total.input += u.input;
    total.cacheWrite += u.cacheWrite;
    total.cacheRead += u.cacheRead;
    total.output += u.output;
    total.requests += u.requests;
    total.costUsd += u.costUsd;
  }
  return total;
}

/** Кириллица: ~1,5 символа на токен (замер scenarios-gen 03.11.2026). */
const CHARS_PER_TOKEN = 1.5;
/** Ответ: JSON с цитатами плюс размышление на низком усилии (проба 05.11.2026 на 10 местах: ~130 ток., $0,005 за место с кэшем). */
const PLAN_OUTPUT_TOKENS = 200;

/** Оценка без запросов (--plan): вход по длине текстов, вывод — ориентир; системный промпт — без кэша (с запасом). */
export function planCost(items: readonly { name: string; sources: readonly Source[] }[]): AmenitiesUsage {
  const total = emptyAmenitiesUsage();
  for (const it of items) {
    const input = Math.ceil(
      (SYSTEM_PROMPT.length + userPrompt(it.name, it.sources).length) / CHARS_PER_TOKEN,
    );
    addApiUsage(total, { input_tokens: input, output_tokens: PLAN_OUTPUT_TOKENS });
  }
  return total;
}

/** Текст ответа (блоки text подряд). */
export function responseText(content: readonly Anthropic.ContentBlock[]): string {
  return content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}
