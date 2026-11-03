// Обложки мест у нас (places:enrich --covers, решение владельца 03.11.2026): одно фото на место, WebP до 400 px.
// Источник: пам'ятка с фото Вікіпедії — файл Wikimedia Commons (бесплатно, с автором и лицензией), иначе первое фото
// Google (запрос Place Photos в месячном пределе google_api_usage; скачивание файла по photoUri не тарифицируется).
// Подпись автора обязательна и хранится рядом с файлом.
import { regionContext, withTenant, type Db, type GoogleAuthor } from "../db/index.js";
import {
  GoogleRateLimitedError,
  RequestLimitError,
  type GooglePlacesClient,
} from "../places-import/google-client.js";
import type { EnrichedPlace } from "./enrich.js";
import { retryAfterMs } from "./wikipedia.js";

export const COVER_WIDTH = 400;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const USER_AGENT =
  "TouristGuideBot/0.1 (Telegram Mini App Tourist Guide, Carpathians; places:enrich offline batch)";

export type Cover = {
  bytes: Buffer;
  mime: "image/webp";
  width: number;
  height: number;
  authors: GoogleAuthor[];
  license: string | null;
  sourceUrl: string | null;
  source: "google" | "wikimedia";
  photoName: string;
};

/** Уменьшение до WebP (подменяется в тестах). */
export type Resize = (input: Buffer) => Promise<{ data: Buffer; width: number; height: number }>;

export const sharpResize: Resize = async (input) => {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: COVER_WIDTH, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/** Wikimedia временно недоступна (429/5xx/сеть): обложка откладывается до следующего прогона, Google не тратится. */
export class WikimediaUnavailableError extends Error {
  override readonly name = "WikimediaUnavailableError";
  /** 429: Wikimedia просит не нагружать — до конца прогона к ней не обращаться. */
  constructor(
    message: string,
    readonly rateLimited = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Скачивание файла Commons с повторами при 429/5xx/сети (паузы delaysMs; Retry-After — если дольше). */
async function download(
  url: string,
  fetchImpl: typeof fetch,
  retry: {
    delaysMs?: readonly number[] | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  } = {},
): Promise<Buffer> {
  const delays = retry.delaysMs ?? [];
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadOnce(url, fetchImpl);
    } catch (err) {
      if (!(err instanceof WikimediaUnavailableError) || attempt >= delays.length) throw err;
      await sleep(Math.max(delays[attempt]!, err.retryAfterMs ?? 0));
    }
  }
}

async function downloadOnce(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(url)) throw new Error("Не файл Wikimedia");
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new WikimediaUnavailableError(`Wikimedia: ${err instanceof Error ? err.name : "сеть"}`);
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    throw new WikimediaUnavailableError(
      `Wikimedia: HTTP ${res.status}`,
      res.status === 429,
      retryAfterMs(res),
    );
  }
  if (!res.ok) throw new Error(`Wikimedia: HTTP ${res.status}`);
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Обрыв/таймаут при чтении тела — тоже временно.
    throw new WikimediaUnavailableError(`Wikimedia: ${err instanceof Error ? err.name : "обрыв"}`);
  }
  if (buf.length > MAX_SOURCE_BYTES) throw new Error("Файл Wikimedia слишком большой");
  return buf;
}

/** Есть ли у места источник обложки. */
export const hasCoverSource = (p: Pick<EnrichedPlace, "google" | "wiki">) =>
  Boolean(p.wiki?.image || p.google?.photos.length);

/**
 * Обложка места или null (нет источника). Wikimedia — первой (бесплатно); постоянная ошибка (4xx, слишком большой
 * файл, не обработался) — Google (если есть фото), иначе ошибка Wikimedia. Временная (429/5xx/сеть) —
 * WikimediaUnavailableError: обложка откладывается, Google не тратится. Предел Google — RequestLimitError (вызывающий прекращает Google-обложки
 * до следующего месяца). googleStopped — Google-обложки уже остановлены пределом: только Wikimedia.
 */
export async function makeCover(
  p: Pick<EnrichedPlace, "google" | "wiki">,
  deps: {
    google: GooglePlacesClient;
    fetch?: typeof fetch;
    resize?: Resize;
    googleStopped?: boolean;
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<Cover | null> {
  const resize = deps.resize ?? sharpResize;
  const img = p.wiki?.image;
  const photo = p.google?.photos[0];
  if (img) {
    try {
      const r = await resize(
        await download(img.url, deps.fetch ?? fetch, { delaysMs: deps.retryDelaysMs, sleep: deps.sleep }),
      );
      return {
        bytes: r.data,
        mime: "image/webp",
        width: r.width,
        height: r.height,
        authors: img.author ? [{ name: img.author, uri: img.sourceUrl, photoUri: null }] : [],
        license: img.license,
        sourceUrl: img.sourceUrl,
        source: "wikimedia",
        photoName: img.url,
      };
    } catch (err) {
      if (err instanceof WikimediaUnavailableError || !photo || deps.googleStopped) throw err;
    }
  }
  if (!photo || deps.googleStopped) return null;
  const uri = await deps.google.photoUri(photo.name, COVER_WIDTH);
  if (!uri) return null;
  const r = await resize(await deps.google.photoBytes(photo.name, uri));
  return {
    bytes: r.data,
    mime: "image/webp",
    width: r.width,
    height: r.height,
    authors: photo.authors,
    license: null,
    sourceUrl: null,
    source: "google",
    photoName: photo.name,
  };
}

/** google_place_id мест региона, у которых обложка уже есть (повторный прогон их пропускает). */
export async function existingCovers(db: Db, regionId: string): Promise<Set<string>> {
  return withTenant(db, regionContext(regionId), async (trx) => {
    const rows = await trx
      .selectFrom("place_cover_photos")
      .innerJoin("places", "places.id", "place_cover_photos.place_id")
      .select("places.google_place_id")
      .execute();
    return new Set(rows.flatMap((r) => (r.google_place_id ? [r.google_place_id] : [])));
  });
}

export async function writeCover(
  db: Db,
  regionId: string,
  googlePlaceId: string,
  c: Cover,
): Promise<boolean> {
  return withTenant(db, regionContext(regionId), async (trx) => {
    const place = await trx
      .selectFrom("places")
      .select("id")
      .where("google_place_id", "=", googlePlaceId)
      .executeTakeFirst();
    if (!place) return false;
    const values = {
      bytes: c.bytes,
      mime: c.mime,
      width: c.width,
      height: c.height,
      author_attributions: JSON.stringify(c.authors),
      license: c.license,
      source_url: c.sourceUrl,
      source: c.source,
      photo_name: c.photoName,
      fetched_at: new Date(),
    };
    await trx
      .insertInto("place_cover_photos")
      .values({ region_id: regionId, place_id: place.id, ...values })
      .onConflict((oc) => oc.columns(["region_id", "place_id"]).doUpdateSet(values))
      .execute();
    return true;
  });
}

export type CoverStats = {
  needed: number;
  existing: number;
  written: number;
  wikimedia: number;
  google: number;
  failed: number;
  /** Google-обложки отложены пределом (следующий месяц). */
  deferred: number;
  /** Wikimedia временно недоступна (429/5xx/сеть) — отложены до следующего прогона. */
  wikiUnavailable: number;
  /** Отложены: поминутная квота Google (429 после всех повторов) — повторить прогоном позже. */
  rateLimited: number;
  /** Только Wikimedia: у места нет надёжного фото Commons (P18 объекта статьи) — без обложки. */
  noWikiImage: number;
};

/** Обложки для мест без неё; запись — только с db (иначе — подсчёт). */
export async function runCovers(
  places: readonly EnrichedPlace[],
  deps: {
    google: GooglePlacesClient;
    db?: Db;
    regionId?: string;
    existing: ReadonlySet<string>;
    write: boolean;
    fetch?: typeof fetch;
    resize?: Resize;
    log?: (s: string) => void;
    /** Только Wikimedia: Google не вызывается вовсе; места без фото Commons — без обложки (noWikiImage). */
    wikimediaOnly?: boolean;
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<CoverStats> {
  const stats: CoverStats = {
    needed: 0,
    existing: 0,
    written: 0,
    wikimedia: 0,
    google: 0,
    failed: 0,
    deferred: 0,
    wikiUnavailable: 0,
    rateLimited: 0,
    noWikiImage: 0,
  };
  let googleStopped = Boolean(deps.wikimediaOnly);
  // После 429 от Wikimedia — к ней больше не обращаться до конца прогона.
  let wikiStopped = false;
  for (const p of places) {
    // Режим Wikimedia: подпись автора обязательна, файл без неё — как нет файла. wiki undefined — место не искали
    // (сбой или лимит Вікіпедії): это не «нет фото».
    if (deps.wikimediaOnly && !p.wiki?.image?.author) {
      if (p.wiki !== undefined && !deps.existing.has(p.googlePlaceId)) stats.noWikiImage++;
      continue;
    }
    if (!hasCoverSource(p)) continue;
    if (deps.existing.has(p.googlePlaceId)) {
      stats.existing++;
      continue;
    }
    stats.needed++;
    if (!deps.write || !deps.db || !deps.regionId) continue;
    if (p.wiki?.image && wikiStopped) {
      stats.wikiUnavailable++;
      continue;
    }
    if (!p.wiki?.image && googleStopped) {
      stats.deferred++;
      continue;
    }
    try {
      const c = await makeCover(p, { ...deps, googleStopped });
      if (!c) {
        stats.failed++;
        continue;
      }
      if (await writeCover(deps.db, deps.regionId, p.googlePlaceId, c)) {
        stats.written++;
        if (c.source === "wikimedia") stats.wikimedia++;
        else stats.google++;
      }
    } catch (err) {
      if (err instanceof WikimediaUnavailableError) {
        deps.log?.(`Обложка ${p.googlePlaceId}: ${err.message} — отложена до следующего прогона`);
        // Режим Wikimedia ждёт паузы повторов: и после 5xx/сети следующие обложки ждали бы их снова.
        if (err.rateLimited || deps.wikimediaOnly) wikiStopped = true;
        stats.wikiUnavailable++;
        continue;
      }
      if (err instanceof GoogleRateLimitedError) {
        deps.log?.(`Обложка ${p.googlePlaceId}: ${err.message}`);
        stats.rateLimited++;
        continue;
      }
      if (err instanceof RequestLimitError) {
        deps.log?.(err.message);
        googleStopped = true;
        stats.deferred++;
        continue;
      }
      stats.failed++;
      deps.log?.(`Обложка ${p.googlePlaceId}: ${err instanceof Error ? err.message : "ошибка"}`);
    }
  }
  return stats;
}
