// Точечный импорт (places:import-google --queries-file / --query): конкретные достопримечательности по списку запросов
// Text Search — одна страница на запрос, категория задаётся запросом (а не типами Google), берутся первые `take`
// подходящих результатов. Места — только из ответа Google; дубли — по google place id (в прогоне и upsert в writer).
import { readFile } from "node:fs/promises";
import type { LonLat } from "../db/index.js";
import { IMPORT_LOCALITIES, TARGETED_LOCALITIES, type ImportLocality } from "./config.js";
import {
  GoogleRateLimitedError,
  RequestLimitError,
  type GooglePlacesClient,
  type SearchTextRequest,
} from "./google-client.js";
import {
  boundingBox,
  GOOGLE_PLACE_ID,
  haversineMeters,
  mapPlace,
  nearestLocality,
  type GooglePlace,
  type MappedPlace,
} from "./mapping.js";

export type TargetedQuery = {
  /** Текст Text Search («Говерла», «Манявський скит»). */
  query: string;
  /** Код нашей подкатегории (nature, sights, museums, markets…) — задаётся явно. */
  category: string;
  /** Центр области поиска; по умолчанию — центр региона. */
  near?: LonLat;
  /** Радиус области поиска, м (по умолчанию DEFAULT_RADIUS_M). */
  radiusM?: number;
  /** Населённый пункт места; не задан — ближайший в радиусе пункта, иначе без пункта. */
  locality?: string;
  /** Сколько первых подходящих результатов взять (по умолчанию 1). */
  take?: number;
  /** Брать только результаты с одним из этих типов Google (если задано). */
  types?: string[];
};

/** Область по умолчанию: Прикарпаття (центр между Яремче, Косовом и Чорногорою). */
export const DEFAULT_NEAR: LonLat = { lon: 24.7, lat: 48.35 };
export const DEFAULT_RADIUS_M = 60_000;
const MAX_TAKE = 20;

export class TargetedQueryError extends Error {
  override readonly name = "TargetedQueryError";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Проверка списка запросов (JSON-массив TargetedQuery) и известных кодов категорий/пунктов. */
export function parseTargetedQueries(
  raw: unknown,
  known: { categories: ReadonlySet<string>; localities: ReadonlySet<string> },
): TargetedQuery[] {
  if (!Array.isArray(raw) || !raw.length)
    throw new TargetedQueryError("Список запросов — непустой JSON-массив");
  return raw.map((r: unknown, i) => {
    const at = `запрос #${i + 1}`;
    if (!r || typeof r !== "object") throw new TargetedQueryError(`${at}: ожидается объект`);
    const q = r as Record<string, unknown>;
    if (typeof q.query !== "string" || !q.query.trim()) throw new TargetedQueryError(`${at}: нет query`);
    if (typeof q.category !== "string" || !known.categories.has(q.category))
      throw new TargetedQueryError(`${at} («${q.query}»): неизвестная категория ${String(q.category)}`);
    const out: TargetedQuery = { query: q.query.trim(), category: q.category };
    if (q.near !== undefined) {
      const n = q.near as Record<string, unknown> | null;
      if (!n || !isNum(n.lon) || !isNum(n.lat) || Math.abs(n.lat) > 90 || Math.abs(n.lon) > 180)
        throw new TargetedQueryError(`${at}: near — {lon, lat}`);
      out.near = { lon: n.lon, lat: n.lat };
    }
    if (q.radiusM !== undefined) {
      if (!isNum(q.radiusM) || q.radiusM < 100 || q.radiusM > 200_000)
        throw new TargetedQueryError(`${at}: radiusM — от 100 до 200000`);
      out.radiusM = q.radiusM;
    }
    if (q.locality !== undefined) {
      if (typeof q.locality !== "string" || !known.localities.has(q.locality))
        throw new TargetedQueryError(`${at}: неизвестный населённый пункт ${String(q.locality)}`);
      out.locality = q.locality;
    }
    if (q.take !== undefined) {
      if (!Number.isSafeInteger(q.take) || (q.take as number) < 1 || (q.take as number) > MAX_TAKE)
        throw new TargetedQueryError(`${at}: take — от 1 до ${MAX_TAKE}`);
      out.take = q.take as number;
    }
    if (q.types !== undefined) {
      if (!Array.isArray(q.types) || !q.types.every((t) => typeof t === "string"))
        throw new TargetedQueryError(`${at}: types — массив строк`);
      out.types = q.types as string[];
    }
    return out;
  });
}

/** `--query "текст=категория"` → запрос с областью по умолчанию. */
export function parseQueryFlag(raw: string): { query: string; category: string } {
  const eq = raw.lastIndexOf("=");
  const query = eq > 0 ? raw.slice(0, eq).trim() : "";
  const category = eq > 0 ? raw.slice(eq + 1).trim() : "";
  if (!query || !category) throw new TargetedQueryError(`--query «${raw}»: нужен вид «текст=категория»`);
  return { query, category };
}

export async function readTargetedQueries(
  file: string,
  known: { categories: ReadonlySet<string>; localities: ReadonlySet<string> },
): Promise<TargetedQuery[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new TargetedQueryError(`Файл запросов ${file}: ${(err as Error).message}`);
  }
  return parseTargetedQueries(raw, known);
}

export type TargetedOutcome = {
  query: string;
  category: string;
  /** Взятые места: название и id Google. */
  /** reused — то же место уже взято другим запросом (записывается один раз, с категорией первого). */
  found: { name: string; googlePlaceId: string; locality: string; reused?: boolean }[];
  /** Почему ничего не взято (пусто у Google, всё отфильтровано, лимит). */
  missing?: string;
};

export type TargetedResult = {
  places: MappedPlace[];
  outcomes: TargetedOutcome[];
  queriesDone: number;
  limitReached: boolean;
};

/** Все пункты, известные точечному импорту (пилот + дополнительные). */
export const ALL_LOCALITIES: readonly ImportLocality[] = [...IMPORT_LOCALITIES, ...TARGETED_LOCALITIES];

/**
 * Выбор и маппинг результатов одного запроса (без сети). Подходящий результат, уже взятый другим запросом (`taken`),
 * засчитывается этому запросу (reused) и занимает место в take — следующий результат выдачи вместо него не берётся:
 * иначе под категорию запроса попал бы посторонний объект («Говерла гора» → готель).
 */
export function pickResults(
  q: TargetedQuery,
  results: readonly GooglePlace[],
  categoryNames: Readonly<Record<string, string>>,
  taken: ReadonlyMap<string, MappedPlace>,
): { place: MappedPlace; reused: boolean }[] {
  const near = q.near ?? DEFAULT_NEAR;
  const radius = q.radiusM ?? DEFAULT_RADIUS_M;
  const out: { place: MappedPlace; reused: boolean }[] = [];
  for (const p of results) {
    if (out.length >= (q.take ?? 1)) break;
    if (!GOOGLE_PLACE_ID.test(p.id ?? "")) continue;
    if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
    const lat = p.location?.latitude;
    const lon = p.location?.longitude;
    if (!isNum(lat) || !isNum(lon) || haversineMeters({ lon, lat }, near) > radius) continue;
    if (q.types?.length && ![p.primaryType, ...(p.types ?? [])].some((t) => t && q.types!.includes(t)))
      continue;
    const name = p.displayName?.text?.trim();
    if (!name) continue;
    const prev = taken.get(p.id);
    if (prev) {
      out.push({ place: prev, reused: true });
      continue;
    }
    const locality = q.locality
      ? ALL_LOCALITIES.find((l) => l.code === q.locality)
      : nearestLocality({ lon, lat }, ALL_LOCALITIES);
    // Маппинг общий (контакты, график, фото, описание); категория — из запроса; пункт — заданный запросом (даже
    // вне его радиуса поиска) или ближайший; пункта нет — «на Прикарпатті», locality_id = null.
    const own: ImportLocality = {
      ...(locality ?? { code: "", name: { uk: "Прикарпаття" }, inUk: "на Прикарпатті" }),
      at: { lon, lat },
      radiusM: 1,
    };
    const m = mapPlace(p, [own], categoryNames, q.category);
    if (m.ok) out.push({ place: m.place, reused: false });
  }
  return out;
}

/** Выгрузка по списку запросов: по одному Text Search на запрос (pageSize 5, без пагинации). */
export async function collectTargeted(
  client: GooglePlacesClient,
  queries: readonly TargetedQuery[],
  categoryNames: Readonly<Record<string, string>>,
  log: (s: string) => void = () => {},
): Promise<TargetedResult> {
  const places: MappedPlace[] = [];
  const taken = new Map<string, MappedPlace>();
  const outcomes: TargetedOutcome[] = [];
  let queriesDone = 0;
  let limitReached = false;
  for (const q of queries) {
    if (limitReached) {
      outcomes.push({ query: q.query, category: q.category, found: [], missing: "лимит запросов" });
      continue;
    }
    const box = boundingBox(q.near ?? DEFAULT_NEAR, q.radiusM ?? DEFAULT_RADIUS_M);
    const request: SearchTextRequest = {
      textQuery: q.query,
      languageCode: "uk",
      regionCode: "UA",
      pageSize: Math.min(MAX_TAKE, Math.max(5, (q.take ?? 1) * 2)),
      locationRestriction: {
        rectangle: {
          low: { latitude: box.low.lat, longitude: box.low.lon },
          high: { latitude: box.high.lat, longitude: box.high.lon },
        },
      },
    };
    let res;
    try {
      res = await client.searchText(request);
    } catch (err) {
      if (err instanceof RequestLimitError || err instanceof GoogleRateLimitedError) {
        log(err.message);
        limitReached = true;
        outcomes.push({ query: q.query, category: q.category, found: [], missing: "лимит запросов" });
        continue;
      }
      // Ошибка одного запроса (HTTP Google, сеть, таймаут) не прерывает прогон: запрос отмечен, идём дальше.
      const message = err instanceof Error ? err.message : String(err);
      log(`«${q.query}»: ошибка Google — ${message}`);
      outcomes.push({
        query: q.query,
        category: q.category,
        found: [],
        missing: `ошибка Google: ${message}`,
      });
      continue;
    }
    queriesDone++;
    const picked = pickResults(q, res.places ?? [], categoryNames, taken);
    for (const { place, reused } of picked) {
      if (reused) continue;
      taken.set(place.googlePlaceId, place);
      places.push(place);
    }
    const outcome: TargetedOutcome = {
      query: q.query,
      category: q.category,
      found: picked.map(({ place: p, reused }) => ({
        name: p.name,
        googlePlaceId: p.googlePlaceId,
        locality: p.localityCode,
        ...(reused ? { reused: true } : {}),
      })),
    };
    if (!picked.length)
      outcome.missing = res.places?.length
        ? `Google вернул ${res.places.length}, ни один не подошёл (область/типы/закрыто)`
        : "Google ничего не нашёл";
    outcomes.push(outcome);
    log(
      `«${q.query}» → ${q.category}: ${picked.length ? picked.map((p) => p.place.name + (p.reused ? " (уже взято другим запросом)" : "")).join("; ") : outcome.missing}`,
    );
  }
  return { places, outcomes, queriesDone, limitReached };
}
