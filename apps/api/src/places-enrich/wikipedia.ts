// Вікіпедія / Wikimedia Commons для пам'яток (places:enrich): статья ищется рядом с точкой места (geosearch) и
// принимается только при уверенном совпадении названия; опис — uk, иначе en; фото — только файл Commons со
// свободной лицензией, с автором и ссылкой на страницу файла. Ответы кэшируются в файлы каталога кэша, ключей нет.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LonLat } from "../db/index.js";
import type { PlaceEnrichmentWiki } from "../db/index.js";
import { haversineMeters } from "../places-import/mapping.js";
import { httpsUrl } from "./details.js";

/** Категории, для которых ищется Вікіпедія: пам'ятки, природа, музеи. */
export const WIKI_CATEGORIES: ReadonlySet<string> = new Set(["sights", "nature", "museums"]);

/** Радиус поиска статьи от точки места, м: дальше — другое место. */
export const WIKI_RADIUS_M = 1500;
const EXTRACT_MAX = 700;
/** User-Agent обязателен по правилам Wikimedia API. */
const USER_AGENT =
  "TouristGuideBot/0.1 (Telegram Mini App Tourist Guide, Carpathians; places:enrich offline batch)";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Общие слова названий: по ним одним совпадение не считается («Водоспад» ≠ любой водоспад). */
const GENERIC = new Set(
  [
    "водоспад",
    "водоспади",
    "музей",
    "музею",
    "пам'ятник",
    "памятник",
    "пам’ятник",
    "церква",
    "храм",
    "собор",
    "каплиця",
    "озеро",
    "гора",
    "скеля",
    "скелі",
    "міст",
    "парк",
    "оглядовий",
    "майданчик",
    "урочище",
    "джерело",
    "ріка",
    "річка",
    "село",
    "місто",
    "селище",
    "імені",
    "святого",
    "святої",
    "св",
    "та",
    "і",
    "й",
    "на",
    "в",
    "у",
    "біля",
    "the",
    "of",
    "and",
    "waterfall",
    "museum",
    "monument",
    "church",
    "lake",
    "mount",
    "mountain",
    "rock",
    "rocks",
    "bridge",
    "park",
    "viewpoint",
    "village",
    "river",
    "saint",
    "st",
    // Транслитерация общих слов (поиск в англовікіпедії по украинскому названию).
    "vodospad",
    "muzei",
    "tserkva",
    "khram",
    "ozero",
    "hora",
    "skelia",
    "skeli",
    "mist",
    "urochyshche",
    "dzherelo",
    "pamiatnyk",
  ].map((w) => w.replace(/[’']/g, "")),
);

/** Слова названия: нижний регистр, без апострофов и знаков, без общих слов; короче 3 букв — не в счёт. */
export function distinctiveTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[’'ʼ`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** Слова совпадают с учётом падежных окончаний: общий префикс ≥ 5 букв (или слово целиком, если короче). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  const k = Math.min(5, n);
  return a.slice(0, k) === b.slice(0, k) && Math.abs(a.length - b.length) <= 3;
}

/**
 * Доля отличительных слов названия места, найденных в заголовке статьи (0…1). 0 — у места нет отличительных слов
 * (только «Водоспад»): такое место не сопоставляется вовсе.
 */
export function nameScore(placeName: string, title: string): number {
  const p = distinctiveTokens(placeName);
  const t = distinctiveTokens(title);
  if (!p.length || !t.length) return 0;
  const hit = p.filter((w) => t.some((x) => sameWord(w, x))).length;
  // Заголовок с лишними отличительными словами («Музей Івана Франка» vs «Франко») — штраф по доле заголовка.
  const back = t.filter((x) => p.some((w) => sameWord(w, x))).length;
  return Math.min(hit / p.length, back / t.length);
}

/** Уверенное совпадение: все (или почти все) отличительные слова с обеих сторон и рядом. */
export const MATCH_MIN_SCORE = 0.66;

// Транслитерация КМУ 2010 — для поиска в англовікіпедії по украинскому названию.
const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "h",
  ґ: "g",
  д: "d",
  е: "e",
  є: "ie",
  ж: "zh",
  з: "z",
  и: "y",
  і: "i",
  ї: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ь: "",
  ю: "iu",
  я: "ia",
};
export function transliterate(s: string): string {
  return [...s.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
}

type GeoHit = { title: string; lat: number; lon: number; dist: number };

export type WikiPlace = { name: string; location: LonLat };

export type WikiClientOptions = {
  cacheDir: string;
  /** Предел запросов к Вікіпедії за прогон (бесплатно, но вежливо). */
  maxRequests: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Только оценка: без сети, промахи кэша — в planned. */
  planOnly?: boolean;
};

export class WikiLimitError extends Error {
  override readonly name = "WikiLimitError";
}

/** Свободные лицензии Commons (короткие имена). Иное (Fair use, «non-free») — без фото. */
const FREE_LICENSE = /^(cc[ -]?by|cc[ -]?by[ -]?sa|cc0|public domain|pd\b|attribution|gfdl|fal\b)/i;

function stripHtml(s: unknown, max = 200): string | null {
  if (typeof s !== "string") return null;
  const t = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Обрезка описания по границе предложения. */
export function shortExtract(text: string, max = EXTRACT_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

export class WikipediaClient {
  requests = 0;
  cacheHits = 0;
  planned = 0;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WikiClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  private async getJson(url: string): Promise<unknown> {
    const file = path.join(this.options.cacheDir, `wiki-${hash(url)}.json`);
    try {
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      this.cacheHits++;
      return data;
    } catch {
      // нет в кэше
    }
    if (this.options.planOnly) {
      this.planned++;
      return null;
    }
    if (this.requests >= this.options.maxRequests)
      throw new WikiLimitError(`Достигнут лимит запросов к Вікіпедії: ${this.options.maxRequests}`);
    this.requests++;
    const res = await this.fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    // 404 (нет статьи) — тоже ответ: кэшируется как null.
    const data: unknown = res.ok ? await res.json() : res.status === 404 ? null : undefined;
    if (data === undefined) throw new Error(`Вікіпедія: HTTP ${res.status}`);
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return data;
  }

  async geosearch(lang: string, at: LonLat): Promise<GeoHit[]> {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&formatversion=2` +
      `&gscoord=${at.lat.toFixed(5)}%7C${at.lon.toFixed(5)}&gsradius=${WIKI_RADIUS_M}&gslimit=30`;
    const data = await this.getJson(url);
    const list = isObject(data) && isObject(data.query) ? data.query.geosearch : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((h): GeoHit[] =>
      isObject(h) && typeof h.title === "string" && typeof h.lat === "number" && typeof h.lon === "number"
        ? [{ title: h.title, lat: h.lat, lon: h.lon, dist: typeof h.dist === "number" ? h.dist : 0 }]
        : [],
    );
  }

  /** Краткое содержание статьи (REST summary): не статья (неоднозначность) — null. */
  async summary(
    lang: string,
    title: string,
  ): Promise<{ title: string; extract: string; url: string; fileTitle: string | null } | null> {
    const data = await this.getJson(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    );
    if (!isObject(data) || data.type !== "standard") return null;
    const extract = typeof data.extract === "string" ? data.extract.trim() : "";
    const urls =
      isObject(data.content_urls) && isObject(data.content_urls.mobile) ? data.content_urls.mobile : null;
    const url =
      httpsUrl(urls?.page) ?? httpsUrl(`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`);
    if (!extract || !url) return null;
    // Имя файла картинки статьи — из адреса оригинала (…/commons/…/Имя.jpg); не Commons — без фото.
    let fileTitle: string | null = null;
    const orig = isObject(data.originalimage) ? data.originalimage.source : undefined;
    if (typeof orig === "string" && /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//.test(orig)) {
      const last = new URL(orig).pathname.split("/").pop();
      if (last) fileTitle = decodeURIComponent(last);
    }
    return { title: typeof data.title === "string" ? data.title : title, extract, url, fileTitle };
  }

  /** Фото Commons: адрес превью до 1200 px, автор, лицензия; несвободная лицензия или нет данных — null. */
  async commonsImage(fileTitle: string): Promise<PlaceEnrichmentWiki["image"]> {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo" +
      `&iiprop=url%7Cextmetadata&iiurlwidth=1200&titles=${encodeURIComponent(`File:${fileTitle}`)}`;
    const data = await this.getJson(url);
    const pages = isObject(data) && isObject(data.query) ? data.query.pages : undefined;
    const page = Array.isArray(pages) ? pages[0] : undefined;
    const info = isObject(page) && Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined;
    if (!isObject(info)) return null;
    const meta = isObject(info.extmetadata) ? info.extmetadata : {};
    const val = (k: string) => (isObject(meta[k]) ? (meta[k] as Record<string, unknown>).value : undefined);
    const license = stripHtml(val("LicenseShortName"), 60);
    if (!license || !FREE_LICENSE.test(license) || val("NonFree") === "true") return null;
    // Метки utm_* в адресе файла не нужны (и не должны попадать в кэш браузера туриста разными адресами).
    const clean = (v: unknown) => {
      const u = httpsUrl(v);
      return u ? u.split("?")[0]! : null;
    };
    const src = clean(info.thumburl) ?? clean(info.url);
    const sourceUrl = httpsUrl(info.descriptionurl);
    if (!src || !sourceUrl || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(src)) return null;
    return {
      url: src,
      width: typeof info.thumbwidth === "number" ? info.thumbwidth : null,
      height: typeof info.thumbheight === "number" ? info.thumbheight : null,
      author: stripHtml(val("Artist"), 120),
      license,
      licenseUrl: httpsUrl(val("LicenseUrl")),
      sourceUrl,
    };
  }
}

/** Лучшая статья рядом: уверенное совпадение названия, при равенстве — ближе. */
export function bestHit(placeName: string, at: LonLat, hits: readonly GeoHit[]): GeoHit | null {
  let best: { hit: GeoHit; score: number; dist: number } | null = null;
  for (const hit of hits) {
    const score = nameScore(placeName, hit.title);
    if (score < MATCH_MIN_SCORE) continue;
    const dist = haversineMeters(at, { lon: hit.lon, lat: hit.lat });
    if (dist > WIKI_RADIUS_M) continue;
    if (!best || score > best.score || (score === best.score && dist < best.dist))
      best = { hit, score, dist };
  }
  return best?.hit ?? null;
}

/**
 * Статья для места: uk (по названию), иначе en (по транслитерации). Нет уверенного совпадения — null (ничего не
 * выдумываем).
 */
export async function findWikipedia(
  client: WikipediaClient,
  place: WikiPlace,
): Promise<PlaceEnrichmentWiki | null> {
  const attempts: { lang: string; name: string }[] = [
    { lang: "uk", name: place.name },
    { lang: "en", name: transliterate(place.name) },
  ];
  for (const { lang, name } of attempts) {
    const hit = bestHit(name, place.location, await client.geosearch(lang, place.location));
    if (!hit) continue;
    const s = await client.summary(lang, hit.title);
    if (!s) continue;
    const image = s.fileTitle ? await client.commonsImage(s.fileTitle) : null;
    return { lang, title: s.title, url: s.url, extract: shortExtract(s.extract), image };
  }
  return null;
}
