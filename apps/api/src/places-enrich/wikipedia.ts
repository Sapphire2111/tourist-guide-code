// Вікіпедія / Wikimedia Commons для пам'яток (places:enrich): статья ищется рядом с точкой места (geosearch) и
// принимается только при уверенном совпадении названия; опис — uk, иначе en; фото — только файл Commons со
// свободной лицензией, с автором и ссылкой на страницу файла. Ответы кэшируются в файлы каталога кэша, ключей нет.
// Режим --covers-source wikimedia сопоставляет строже — см. wiki-match.ts (клиент общий).
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
export const GENERIC: ReadonlySet<string> = new Set(
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
export function distinctiveTokens(name: string, generic: ReadonlySet<string> = GENERIC): string[] {
  return name
    .toLowerCase()
    .replace(/[’'ʼ`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !generic.has(t));
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

export type GeoHit = { title: string; lat: number; lon: number; dist: number };

export type WikiPlace = { name: string; location: LonLat };

export type WikiClientOptions = {
  cacheDir: string;
  /** Предел запросов к Вікіпедії за прогон (бесплатно, но вежливо). */
  maxRequests: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Только оценка: без сети, промахи кэша — в planned. */
  planOnly?: boolean;
  /** Паузы перед повторами при 429/5xx/сети (Retry-After, если дольше); пусто — без повторов. */
  retryDelaysMs?: readonly number[];
  /** Не чаще одного запроса за столько мс (вежливый темп к API Wikimedia). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Сбой, не снятый повторами (429/5xx/сеть), останавливает сеть до конца прогона: дальше — только кэш. Иначе каждое
   * следующее место снова прождало бы все паузы (10 мест при устойчивом 429 — 40 запросов и 850 с).
   */
  stopOnUnavailable?: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Пауза из Retry-After (секунды), не больше 2 мин; нет — null. */
export function retryAfterMs(res: Response): number | null {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, 120_000) : null;
}

export class WikiLimitError extends Error {
  override readonly name = "WikiLimitError";
}

/** Временный сбой Вікіпедії (429, 5xx, сеть): место не искалось в этом прогоне. */
export class WikiUnavailableError extends Error {
  override readonly name = "WikiUnavailableError";
}

/** Свободные лицензии Commons (короткие имена). Иное (Fair use, «non-free») — без фото. */
const FREE_LICENSE = /^(cc[ -]?by|cc[ -]?by[ -]?sa|cc0|public domain|pd\b|attribution|gfdl|fal\b)/i;
/** «Автор неизвестен» в Commons — подписи всё равно нет. */
const UNKNOWN_AUTHOR = /^((автор|author)\s+)?(unknown|anonym|невідом|неизвест|анонім|аноним)/i;

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
  /** Реальных запросов HTTP, включая повторы (--max-wiki-requests считает их же). */
  requests = 0;
  cacheHits = 0;
  planned = 0;
  /** Повторов после 429/5xx/сети. */
  retries = 0;
  /** Причина остановки сети (stopOnUnavailable); null — сеть не останавливалась. */
  stopped: string | null = null;
  /** Статьи, отклонённые строгим сопоставлением по типу Wikidata (для отчёта: таблица типов в wiki-match.ts). */
  readonly typeRejects: { place: string; title: string; classes: string[] }[] = [];
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastAt = 0;

  constructor(private readonly options: WikiClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Запрос с темпом и повторами при 429/5xx/сети; после всех повторов — последний ответ или WikiUnavailableError. */
  private async request(url: string): Promise<Response> {
    const delays = this.options.retryDelaysMs ?? [];
    for (let attempt = 0; ; attempt++) {
      if (this.requests >= this.options.maxRequests)
        throw new WikiLimitError(`Достигнут лимит запросов к Вікіпедії: ${this.options.maxRequests}`);
      this.requests++;
      const gap = (this.options.minIntervalMs ?? 0) - (Date.now() - this.lastAt);
      if (gap > 0) await this.sleep(gap);
      this.lastAt = Date.now();
      let res: Response | undefined;
      let error: unknown;
      try {
        res = await this.fetch(url, {
          headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
      } catch (err) {
        error = err;
      }
      const transient = !res || res.status === 429 || res.status >= 500;
      if (!transient || attempt >= delays.length) {
        if (res) return res;
        throw new WikiUnavailableError(`Вікіпедія: ${error instanceof Error ? error.name : "сеть"}`);
      }
      const wait = Math.max(delays[attempt]!, res ? (retryAfterMs(res) ?? 0) : 0);
      await res?.body?.cancel();
      this.retries++;
      await this.sleep(wait);
    }
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
    if (this.stopped) throw new WikiUnavailableError(this.stopped);
    let res: Response;
    try {
      res = await this.request(url);
    } catch (err) {
      if (err instanceof WikiUnavailableError) this.stopIfAsked(err.message);
      throw err;
    }
    // 429/5xx и прочее — временный сбой: не кэшируется, место считается «не искали» (повтор следующим прогоном).
    if (!res.ok && res.status !== 404) {
      const message = `Вікіпедія: HTTP ${res.status}`;
      this.stopIfAsked(message);
      throw new WikiUnavailableError(message);
    }
    // 404 (нет статьи) — тоже ответ: кэшируется как null.
    let data: unknown = null;
    if (res.ok) {
      try {
        data = await res.json();
      } catch (err) {
        // Не JSON (страница ошибки прокси) или обрыв тела: то же, что временный сбой, прогон идёт дальше к записи.
        const message = `Вікіпедія: не JSON (${err instanceof Error ? err.name : "ошибка"})`;
        this.stopIfAsked(message);
        throw new WikiUnavailableError(message);
      }
      // Режим Wikimedia: ошибка API при 200 ({error: …}, например ratelimited) — не ответ, в кэш не попадает.
      if (this.options.stopOnUnavailable && isObject(data) && "error" in data) {
        const code = isObject(data.error) && typeof data.error.code === "string" ? data.error.code : "ошибка";
        const message = `Вікіпедія: ошибка API (${code})`;
        this.stopIfAsked(message);
        throw new WikiUnavailableError(message);
      }
    }
    await mkdir(this.options.cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return data;
  }

  private stopIfAsked(reason: string): void {
    if (this.options.stopOnUnavailable) this.stopped = reason;
  }

  async geosearch(lang: string, at: LonLat, radiusM = WIKI_RADIUS_M, limit = 30): Promise<GeoHit[]> {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&formatversion=2` +
      `&gscoord=${at.lat.toFixed(5)}%7C${at.lon.toFixed(5)}&gsradius=${radiusM}&gslimit=${limit}`;
    const data = await this.getJson(url);
    const list = isObject(data) && isObject(data.query) ? data.query.geosearch : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((h): GeoHit[] =>
      isObject(h) && typeof h.title === "string" && typeof h.lat === "number" && typeof h.lon === "number"
        ? [{ title: h.title, lat: h.lat, lon: h.lon, dist: typeof h.dist === "number" ? h.dist : 0 }]
        : [],
    );
  }

  /** Статьи по названию (полнотекстовый поиск) с их координатами; статьи без координат не возвращаются. */
  async searchHits(lang: string, query: string): Promise<GeoHit[]> {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search` +
      `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=8&gsrnamespace=0&prop=coordinates`;
    const data = await this.getJson(url);
    const pages = isObject(data) && isObject(data.query) ? data.query.pages : undefined;
    if (!Array.isArray(pages)) return [];
    return pages.flatMap((p): GeoHit[] => {
      const c = isObject(p) && Array.isArray(p.coordinates) ? p.coordinates[0] : undefined;
      return isObject(p) &&
        typeof p.title === "string" &&
        isObject(c) &&
        typeof c.lat === "number" &&
        typeof c.lon === "number"
        ? [{ title: p.title, lat: c.lat, lon: c.lon, dist: 0 }]
        : [];
    });
  }

  /** Краткое содержание статьи (REST summary): не статья (неоднозначность) — null. */
  async summary(
    lang: string,
    title: string,
  ): Promise<{
    title: string;
    extract: string;
    url: string;
    fileTitle: string | null;
    wikidataId: string | null;
  } | null> {
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
    // Объект Wikidata статьи (строгий режим: тип P31 и фото P18 — только его).
    const wikidataId =
      typeof data.wikibase_item === "string" && /^Q\d+$/.test(data.wikibase_item) ? data.wikibase_item : null;
    return {
      title: typeof data.title === "string" ? data.title : title,
      extract,
      url,
      fileTitle,
      wikidataId,
    };
  }

  /** Значения свойства объекта Wikidata; устаревшие (rank deprecated) — нет. */
  private async wikidataClaims(qid: string, property: string): Promise<Record<string, unknown>[]> {
    const data = await this.getJson(
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&entity=${qid}&property=${property}`,
    );
    const claims = isObject(data) && isObject(data.claims) ? data.claims[property] : undefined;
    if (!Array.isArray(claims)) return [];
    return claims.filter((c): c is Record<string, unknown> => isObject(c) && c.rank !== "deprecated");
  }

  /** Файл P18 («зображення») объекта Wikidata или null: rank preferred, иначе первое обычное значение. */
  async wikidataImage(qid: string): Promise<string | null> {
    const ranked = await this.wikidataClaims(qid, "P18");
    const pick = ranked.find((c) => c.rank === "preferred") ?? ranked[0];
    const snak = pick && isObject(pick.mainsnak) ? pick.mainsnak : undefined;
    const value = snak && isObject(snak.datavalue) ? snak.datavalue.value : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  /** Классы P31 («є одним із») объекта Wikidata: Q-идентификаторы. */
  async wikidataClasses(qid: string): Promise<string[]> {
    return (await this.wikidataClaims(qid, "P31")).flatMap((c) => {
      const snak = isObject(c.mainsnak) ? c.mainsnak : undefined;
      const value = snak && isObject(snak.datavalue) ? snak.datavalue.value : undefined;
      const id = isObject(value) ? value.id : undefined;
      return typeof id === "string" ? [id] : [];
    });
  }

  /**
   * Фото Commons: адрес превью до 1200 px, автор, лицензия; несвободная лицензия или нет данных — null.
   * requireAuthor (строгий режим) — файл без указанного автора тоже null: подпись обязательна.
   */
  async commonsImage(
    fileTitle: string,
    opts: { requireAuthor?: boolean } = {},
  ): Promise<PlaceEnrichmentWiki["image"]> {
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
    const author = stripHtml(val("Artist"), 120);
    if (opts.requireAuthor && (!author || UNKNOWN_AUTHOR.test(author))) return null;
    return {
      url: src,
      width: typeof info.thumbwidth === "number" ? info.thumbwidth : null,
      height: typeof info.thumbheight === "number" ? info.thumbheight : null,
      author,
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
    const extract = shortExtract(s.extract);
    const truncated = extract !== s.extract.replace(/\s+/g, " ").trim();
    return { lang, title: s.title, url: s.url, extract, truncated, image };
  }
  return null;
}
