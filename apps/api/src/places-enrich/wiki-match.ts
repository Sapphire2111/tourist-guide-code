// Строгое сопоставление места со статьёй для --covers-source wikimedia. Точность важнее охвата: поставленная обложка
// при повторном прогоне пропускается (covers.ts), поэтому ошибка не исправится сама — лучше место без обложки и текста.
// Статья принимается, только если сходится всё: название (все слова, уточнение в скобках — географическое), расстояние
// и класс объекта Wikidata (P31 из таблицы для типа места). Только uk.wikipedia, фото — только P18 этого объекта.
import type { LonLat, PlaceEnrichmentWiki } from "../db/index.js";
import { haversineMeters } from "../places-import/mapping.js";
import {
  distinctiveTokens,
  GENERIC,
  shortExtract,
  WIKI_RADIUS_M,
  type GeoHit,
  type WikipediaClient,
} from "./wikipedia.js";

/** Категории режима: пам'ятки, природа, музеи, ринки. */
export const WIKIMEDIA_CATEGORIES: ReadonlySet<string> = new Set(["sights", "nature", "museums", "markets"]);

/** Природа: точка места и координаты статьи о вершине или хребте расходятся сильнее — до 3 км. */
export const WIKI_RADIUS_NATURE_M = 3000;
export const wikiRadius = (categoryCode: string) =>
  categoryCode === "nature" ? WIKI_RADIUS_NATURE_M : WIKI_RADIUS_M;

/** Предел в geosearch режима: в радиусе 3 км у города статей много, нужная не должна выпасть. */
const GEOSEARCH_LIMIT = 100;
/** Сколько подходящих по названию статей проверять по Wikidata (каждая — 2 запроса). */
const MAX_CANDIDATES = 3;
/** Доля совпавших слов с обеих сторон: 2 из 3 мало («Велика Чорна Гора» ≠ «Чорна Гора»), 3 из 4 достаточно. */
export const STRICT_MIN_SCORE = 0.75;

type Kind =
  | "relief"
  | "pass"
  | "rock"
  | "waterfall"
  | "lake"
  | "river"
  | "cave"
  | "museum"
  | "church"
  | "monastery"
  | "monument"
  | "castle"
  | "bridge"
  | "park"
  | "market";

/**
 * Классы P31 по типу места. Только перечисленные точно: подкласс вне таблицы — нет совпадения (охват расширяется
 * добавлением класса, отклонённые видны в отчёте прогона). Населённые пункты, станции, люди, гостиницы не входят.
 */
const WIKIDATA_CLASSES: Readonly<Record<Kind, readonly string[]>> = {
  relief: ["Q8502" /* гора */, "Q207326" /* вершина */, "Q46831" /* хребет */, "Q54050", "Q1061151"],
  pass: ["Q133056"],
  rock: ["Q631305" /* скельне утворення */, "Q8063" /* скеля */, "Q107679" /* кліф */],
  waterfall: ["Q34038"],
  lake: ["Q23397", "Q211302" /* льодовикове */, "Q131681" /* водосховище */, "Q3253281" /* став */],
  river: ["Q4022", "Q47521" /* потік */],
  cave: ["Q35509"],
  museum: ["Q33506", "Q207694", "Q16735822", "Q1595639", "Q756102", "Q1007870"],
  church: ["Q16970", "Q108325" /* каплиця */, "Q2977" /* собор */, "Q317557", "Q1129743", "Q744296"],
  monastery: ["Q44613", "Q160742"],
  monument: ["Q4989906", "Q179700" /* статуя */, "Q575759", "Q5003624"],
  castle: ["Q23413", "Q57821" /* фортифікація */],
  bridge: ["Q12280"],
  park: ["Q22698", "Q46169" /* нацпарк */, "Q179049" /* заповідник */, "Q158454"],
  market: ["Q37654", "Q330284"],
};

/** Слова типа в названии места (без апострофов). */
const KIND_WORDS: Readonly<Record<string, Kind>> = {
  гора: "relief",
  вершина: "relief",
  хребет: "relief",
  масив: "relief",
  перевал: "pass",
  скеля: "rock",
  скелі: "rock",
  водоспад: "waterfall",
  водоспади: "waterfall",
  озеро: "lake",
  ставок: "lake",
  ріка: "river",
  річка: "river",
  печера: "cave",
  музей: "museum",
  церква: "church",
  храм: "church",
  собор: "church",
  каплиця: "church",
  монастир: "monastery",
  скит: "monastery",
  памятник: "monument",
  монумент: "monument",
  меморіал: "monument",
  замок: "castle",
  фортеця: "castle",
  міст: "bridge",
  парк: "park",
  заповідник: "park",
  ринок: "market",
  базар: "market",
};

/** Типы по категории, если в названии типа нет («Говерла», «Синевир»). Неизвестная категория — ничего. */
const CATEGORY_KINDS: Readonly<Record<string, readonly Kind[]>> = {
  nature: ["relief", "pass", "rock", "waterfall", "lake", "river", "cave", "park"],
  sights: [
    "church",
    "monastery",
    "monument",
    "castle",
    "museum",
    "bridge",
    "park",
    "relief",
    "pass",
    "rock",
    "waterfall",
    "lake",
    "cave",
  ],
  museums: ["museum"],
  markets: ["market"],
};

/** Общие слова: как в обычном режиме, плюс все слова типа (сравниваются отдельно). */
const STRICT_GENERIC: ReadonlySet<string> = new Set([...GENERIC, ...Object.keys(KIND_WORDS)]);

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’'ʼ`]/g, "")
    .split(/[^\p{L}\p{N}]+/u);

function kindsOf(name: string): Set<Kind> {
  const out = new Set<Kind>();
  for (const w of words(name)) {
    const k = KIND_WORDS[w];
    if (k) out.add(k);
  }
  return out;
}

/** Классы Wikidata, допустимые для места: по слову типа в названии, иначе по категории. */
export function allowedClasses(categoryCode: string, placeName: string): ReadonlySet<string> {
  const named = [...kindsOf(placeName)];
  const kinds = named.length ? named : (CATEGORY_KINDS[categoryCode] ?? []);
  return new Set(kinds.flatMap((k) => WIKIDATA_CLASSES[k]));
}

/** Слова географического уточнения кроме топонимов (те — с прописной). */
const GEO_QUALIFIER_WORDS = new Set([
  "район",
  "область",
  "громада",
  "в",
  "у",
  "на",
  "біля",
  "поблизу",
  "поруч",
  "і",
  "та",
]);
const TOPONYM = /^[А-ЯҐЄІЇ][а-яґєії’'ʼ]+(-[А-ЯҐЄІЇа-яґєії][а-яґєії’'ʼ]+)*$/;

/**
 * Уточнение в скобках снимается, только если оно географическое или называет тип объекта: «(Чорногора)»,
 * «(Яремчанський район)», «(гора)». «(заказник)», «(готель)», «(станція)», «(фільм)», «(2005)» — другой объект.
 */
function neutralQualifier(q: string): boolean {
  const tokens = q.split(/[\s,]+/).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((t) => {
      const lower = t.toLowerCase().replace(/[’'ʼ`]/g, "");
      return TOPONYM.test(t) || GEO_QUALIFIER_WORDS.has(lower) || lower in KIND_WORDS;
    })
  );
}

/**
 * Слова совпадают с учётом падежных окончаний: общая основа ≥ 4 букв и отличие только в окончании (≤ 2 букв с каждой
 * стороны). «Довбуш» = «Довбуша», «Пробій» = «Пробою»; «Чорногора» ≠ «Чорноголова», «Верховина» ≠ «Верхова».
 */
function sameWordStrict(a: string, b: string): boolean {
  if (a === b) return true;
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k >= 4 && a.length - k <= 2 && b.length - k <= 2;
}

/** Совпадение названия со статьёй (0…1): 0 — другой объект по уточнению или слову типа. */
export function strictNameScore(placeName: string, title: string): number {
  const qualifiers = [...title.matchAll(/\(([^)]*)\)/g)].map((m) => m[1] ?? "");
  if (!qualifiers.every(neutralQualifier)) return 0;
  const placeKinds = kindsOf(placeName);
  const titleKinds = kindsOf(title);
  // Тип назван с обеих сторон и расходится: «Гора Близниця» ≠ «Скелі Близниці».
  if (placeKinds.size && titleKinds.size && ![...placeKinds].some((k) => titleKinds.has(k))) return 0;
  const p = distinctiveTokens(placeName, STRICT_GENERIC);
  const t = distinctiveTokens(title.replace(/\([^)]*\)/g, " "), STRICT_GENERIC);
  if (!p.length || !t.length) return 0;
  const hit = p.filter((w) => t.some((x) => sameWordStrict(w, x))).length;
  const back = t.filter((x) => p.some((w) => sameWordStrict(w, x))).length;
  return Math.min(hit / p.length, back / t.length);
}

/** Статьи, подходящие по названию и расстоянию: лучшие первыми, при равенстве — ближе. */
export function strictCandidates(
  placeName: string,
  at: LonLat,
  hits: readonly GeoHit[],
  radiusM: number,
): GeoHit[] {
  return hits
    .flatMap((hit) => {
      const score = strictNameScore(placeName, hit.title);
      const dist = haversineMeters(at, { lon: hit.lon, lat: hit.lat });
      return score >= STRICT_MIN_SCORE && dist <= radiusM ? [{ hit, score, dist }] : [];
    })
    .sort((a, b) => b.score - a.score || a.dist - b.dist)
    .map((c) => c.hit);
}

export type StrictPlace = { name: string; location: LonLat; categoryCode: string };

/** Статья для места или null (ничего не выдумываем). Сбои Вікіпедії — исключения клиента, место не считается искомым. */
export async function findWikipediaStrict(
  client: WikipediaClient,
  place: StrictPlace,
): Promise<PlaceEnrichmentWiki | null> {
  const allowed = allowedClasses(place.categoryCode, place.name);
  if (!allowed.size) return null;
  const radius = wikiRadius(place.categoryCode);
  const lang = "uk";
  // Рядом по координатам; не нашлось — поиск по названию, координаты статьи всё равно в радиусе.
  let hits = strictCandidates(
    place.name,
    place.location,
    await client.geosearch(lang, place.location, radius, GEOSEARCH_LIMIT),
    radius,
  );
  if (!hits.length)
    hits = strictCandidates(place.name, place.location, await client.searchHits(lang, place.name), radius);
  for (const hit of hits.slice(0, MAX_CANDIDATES)) {
    const s = await client.summary(lang, hit.title);
    // Перенаправление на другую статью проверяется заново; нет объекта Wikidata — тип не подтвердить.
    if (!s?.wikidataId || strictNameScore(place.name, s.title) < STRICT_MIN_SCORE) continue;
    const classes = await client.wikidataClasses(s.wikidataId);
    if (!classes.some((c) => allowed.has(c))) {
      client.typeRejects.push({ place: place.name, title: s.title, classes });
      continue;
    }
    // Фото — только P18 этого объекта: нет P18 или автора — статья без фото.
    const file = await client.wikidataImage(s.wikidataId);
    const image = file ? await client.commonsImage(file, { requireAuthor: true }) : null;
    const extract = shortExtract(s.extract);
    const truncated = extract !== s.extract.replace(/\s+/g, " ").trim();
    return { lang, title: s.title, url: s.url, extract, truncated, image };
  }
  return null;
}
