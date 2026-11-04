// Применение ручной разметки мест (CLI places:curate): перенос категории, архив, слияние дублей, переименование,
// исправление населённого пункта. Всё — в одной транзакции в tenant-контексте региона (TenantGuardPlugin + RLS);
// каждое изменённое место — запись аудита place.curate. --dry-run выполняет те же запросы и откатывает транзакцию
// (план = реальный результат, включая проверки ограничений БД).
// Слияние дублей ничего не удаляет: дубль → archived, ссылки (избранное, пункты сценариев и их альтернативы,
// «где живу» в планах, QR-точки) переносятся на главную запись; остальные ссылки (брони, отзывы, модули хоста,
// заявки, офферы…) остаются на дубле и попадают в отчёт.
import { sql } from "kysely";
import {
  lonLatOf,
  regionContext,
  withTenant,
  type Db,
  type LocalizedText,
  type PlaceUpdate,
} from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { IMPORT_LOCALITIES, SEARCH_ZONES } from "../places-import/config.js";
import { localityOf } from "../places-import/mapping.js";
import {
  bookingBaseName,
  classifyFix,
  localityFromAddress,
  normalizeName,
  type Decision,
  type Finding,
} from "./rules.js";

export const CURATE_ACTION = "place.curate";
export const CURATE_REASON = "аудит категорий 04.11";

export type CurateOptions = {
  regionCode: string;
  findings: readonly Finding[];
  decisions: readonly Decision[];
  /** id мест с расхождением пункта и адреса Google (issues_auto.csv, «Пункт: …»). */
  localityIssueIds: readonly string[];
  dryRun: boolean;
  /** Радиус поиска основной записи для номеров Booking, м. */
  bookingRadiusM?: number;
  /**
   * Осторожные слияния (автоматика places:check): слияние пропускается (в todo), если у дубля или главной есть
   * организация партнёра, источник не google или данные/ссылки, которые слияние не переносит (MERGE_BLOCKING_TABLES).
   */
  guardMerges?: boolean;
  /** Начало причины в аудите (по умолчанию CURATE_REASON). */
  reason?: string;
};

export type TodoItem = { line: number | null; id: string; name: string; finding?: Finding; reason: string };

type PlaceRow = {
  id: string;
  name: LocalizedText;
  description: LocalizedText | null;
  address: string | null;
  category: string;
  status: string;
  locality: string | null;
  lon: number | null;
  lat: number | null;
  ratingCount: number;
  photos: number;
  hasAi: boolean;
  addressI18n: LocalizedText | null;
  organizationId: string | null;
  source: string;
  phone: string | null;
  website: string | null;
};

type Change = {
  id: string;
  category?: string;
  extras: Set<string>;
  archive?: boolean;
  name?: string;
  description?: string;
  locality?: string;
  mergeInto?: string;
  /** Архив → published (отмена ошибочного архива/слияния). */
  restore?: boolean;
  address?: string;
  /** Номера строк разметки / пометки решений — в причину аудита. */
  sources: string[];
};

export type CurateReport = {
  dryRun: boolean;
  changedPlaces: number;
  /** Изменения по местам (как в аудите) — для выборочной проверки плана. */
  details: {
    id: string;
    name: string;
    old: Record<string, unknown>;
    new: Record<string, unknown>;
    sources: string[];
  }[];
  counts: Record<string, number>;
  moves: Record<string, number>;
  todo: TodoItem[];
  merges: { dup: string; main: string; dupName: string; mainName: string; kind: "booking" | "decision" }[];
  /** Контакты (телефон, сайт), перенесённые с дубля на главную, у которой их не было. */
  contactsMoved: { main: string; name: string; from: string; phone?: string; website?: string }[];
  leftRefs: { dup: string; table: string; count: number }[];
  movedRefs: Record<string, number>;
  /** Пункты сценариев, где осталось неопубликованное место архива чистки (нет опубликованной замены). */
  archivedInScenarios: { id: string; name: string; items: number }[];
  /** Исправленные пункты сценариев: замена архивного места, чистка альтернатив. */
  scenarioFixes: {
    item: string;
    scenario: string;
    replaced?: { from: string; to: string };
    removedAlternatives: string[];
  }[];
  bookingNotes: string[];
  publishedByCategory: { before: Record<string, number>; after: Record<string, number> };
  publishedRoomSuffix: { before: number; after: number };
  peaksCheck: { id: string; name: string; category: string; status: string }[];
  lines: string[];
};

class DryRunRollback extends Error {}

/** Сайты-агрегаторы бронирования: их ссылку с дубля-номера на главную не переносим. */
const BOOKING_AGGREGATOR =
  /^https:\/\/([a-z0-9-]+\.)*(bluepillow|freecancellations|booking|hotels|agoda|expedia|trip|airbnb|vio)\.[a-z.]+\//i;

/** Контроль: опубликованные с суффиксом номера Booking (регэксп PostgreSQL). */
const ROOM_SUFFIX_RE =
  " - [A-Za-z][A-Za-z &-]*(Room|House|Villa|Apartment|Suite|Studio|Townhouse|Chalet|Cottage|Home)[A-Za-z &-]*$";

function haversine(a: PlaceRow, b: PlaceRow): number {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return Number.POSITIVE_INFINITY;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Главная запись среди кандидатов: больше отзывов, фото, есть ИИ-текст, длиннее описание, опубликована. */
export function pickMain<
  T extends Pick<PlaceRow, "ratingCount" | "photos" | "hasAi" | "description" | "status" | "id">,
>(rows: readonly T[]): T {
  const score = (p: T) => [
    p.status === "published" ? 1 : 0,
    p.ratingCount,
    p.photos,
    p.hasAi ? 1 : 0,
    p.description?.uk.length ?? 0,
  ];
  return [...rows].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}

export async function curatePlaces(db: Db, opts: CurateOptions): Promise<CurateReport> {
  const region = await db
    .selectFrom("regions")
    .select("id")
    .where("code", "=", opts.regionCode)
    .executeTakeFirst();
  if (!region) throw new Error(`Регион ${opts.regionCode} не найден`);
  let report: CurateReport | undefined;
  try {
    await withTenant(db, regionContext(region.id), async (trx) => {
      report = await run(trx as unknown as Db, opts);
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return report!;
}

async function publishedByCategory(trx: Db): Promise<Record<string, number>> {
  const rows = await trx
    .selectFrom("places as p")
    .innerJoin("categories as c", "c.id", "p.category_id")
    .select(["c.code", (eb) => eb.fn.countAll<string>().as("n")])
    .where("p.status", "=", "published")
    .groupBy("c.code")
    .orderBy("c.code")
    .execute();
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.n)]));
}

async function publishedRoomSuffix(trx: Db): Promise<number> {
  const row = await trx
    .selectFrom("places")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("status", "=", "published")
    .where(sql<boolean>`name_i18n ->> 'uk' ~ ${ROOM_SUFFIX_RE}`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function run(trx: Db, opts: CurateOptions): Promise<CurateReport> {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const todo: TodoItem[] = [];
  const radius = opts.bookingRadiusM ?? 2000;
  const reasonPrefix = opts.reason ?? CURATE_REASON;

  const categories = new Map(
    (await trx.selectFrom("categories").select(["id", "code"]).execute()).map((c) => [c.code, c.id] as const),
  );
  const localities = new Map(
    (await trx.selectFrom("localities").select(["id", "code"]).execute()).map((l) => [l.code, l.id] as const),
  );
  const raw = await trx
    .selectFrom("places as p")
    .innerJoin("categories as c", "c.id", "p.category_id")
    .leftJoin("localities as l", "l.id", "p.locality_id")
    .leftJoin("place_enrichments as e", "e.place_id", "p.id")
    .select([
      "p.id",
      "p.name_i18n",
      "p.description_i18n",
      "p.phone",
      "p.website",
      "p.address_i18n",
      "p.organization_id",
      "p.source",
      sql<string | null>`p.address_i18n ->> 'uk'`.as("address"),
      "c.code as category",
      "p.status",
      "l.code as locality",
      (eb) => lonLatOf(eb.ref("p.location")).as("ll"),
      sql<string | null>`e.google ->> 'ratingCount'`.as("rc"),
      sql<number>`coalesce(jsonb_array_length(e.google -> 'photos'), 0)`.as("photos"),
      sql<boolean>`e.ai_summary_uk is not null`.as("ai"),
    ])
    .execute();
  const places = new Map<string, PlaceRow>(
    raw.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name_i18n,
        description: r.description_i18n,
        address: r.address,
        category: r.category,
        status: r.status,
        locality: r.locality,
        lon: r.ll?.lon ?? null,
        lat: r.ll?.lat ?? null,
        ratingCount: Number(r.rc ?? 0) || 0,
        photos: Number(r.photos) || 0,
        hasAi: Boolean(r.ai),
        phone: r.phone,
        website: r.website,
        addressI18n: r.address_i18n,
        organizationId: r.organization_id,
        source: r.source,
      },
    ]),
  );

  // Прошлые прогоны чистки (идемпотентность): какие места уже архивированы чисткой и кому чистка ставила пункт.
  const priorAudits = await trx
    .selectFrom("audit_logs")
    .select(["entity_id", "new_values"])
    .where("action", "=", CURATE_ACTION)
    .where("entity_type", "=", "place")
    .execute();
  const priorArchived = new Set<string>();
  const priorLocality = new Set<string>();
  /** Слияния прошлых прогонов: дубль → главная. */
  const priorMerges: { dup: string; main: string }[] = [];
  for (const a of priorAudits) {
    if (!a.entity_id) continue;
    if (a.new_values?.status === "archived") priorArchived.add(a.entity_id);
    if (a.new_values && "locality" in a.new_values) priorLocality.add(a.entity_id);
    if (typeof a.new_values?.mergedInto === "string")
      priorMerges.push({ dup: a.entity_id, main: a.new_values.mergedInto });
  }

  const before = await publishedByCategory(trx);
  const roomBefore = await publishedRoomSuffix(trx);

  const changes = new Map<string, Change>();
  const change = (id: string, source: string): Change => {
    let c = changes.get(id);
    if (!c) changes.set(id, (c = { id, extras: new Set(), sources: [] }));
    if (!c.sources.includes(source)) c.sources.push(source);
    return c;
  };
  const nameOf = (id: string) => places.get(id)?.name.uk ?? "?";
  const addTodo = (f: Finding | undefined, id: string, reason: string) =>
    todo.push({ line: f?.line ?? null, id, name: f?.name ?? nameOf(id), finding: f, reason });

  // --- Ручные решения (заменяют автоматический разбор строк своего id) ---
  const decided = new Map<string, Decision[]>();
  for (const d of opts.decisions) decided.set(d.id, [...(decided.get(d.id) ?? []), d]);
  const findingsById = new Map<string, Finding[]>();
  for (const f of opts.findings) findingsById.set(f.id, [...(findingsById.get(f.id) ?? []), f]);
  const decisionMerges: { dup: string; main: string }[] = [];
  for (const [id, ds] of decided) {
    const f = findingsById.get(id)?.[0];
    if (!places.has(id)) {
      addTodo(f, id, "решение: места нет в БД");
      continue;
    }
    for (const d of ds) {
      const src = `решение${d.note ? `: ${d.note}` : ""}`;
      switch (d.kind) {
        case "move": {
          const bad = [d.category, ...d.extras].filter((c) => !categories.has(c));
          if (bad.length) {
            addTodo(f, id, `категории ${bad.join(", ")} нет в БД`);
            break;
          }
          const c = change(id, src);
          c.category = d.category;
          for (const e of d.extras) c.extras.add(e);
          break;
        }
        case "archive":
          change(id, src).archive = true;
          break;
        case "merge":
          if (!places.has(d.mainId)) addTodo(f, id, `слияние: главной записи ${d.mainId} нет в БД`);
          else {
            decisionMerges.push({ dup: id, main: d.mainId });
            change(id, src);
          }
          break;
        case "rename":
          change(id, src).name = d.name;
          break;
        case "describe":
          change(id, src).description = d.description;
          break;
        case "locality":
          if (!localities.has(d.locality)) addTodo(f, id, `пункта ${d.locality} нет в БД`);
          else change(id, src).locality = d.locality;
          break;
        case "restore":
          change(id, src).restore = true;
          break;
        case "address":
          change(id, src).address = d.address;
          break;
        case "skip":
          for (const ff of findingsById.get(id) ?? [undefined])
            addTodo(ff, id, d.note || "решено не применять");
          break;
      }
    }
  }

  // --- Автоматический разбор остальных строк ---
  const bookingRows: Finding[] = [];
  for (const [id, fs] of findingsById) {
    if (decided.has(id)) continue;
    const p = places.get(id);
    const actions = fs.map((f) => ({ f, a: classifyFix(f) }));
    const applicable = actions.filter((x) => x.a.kind !== "todo");
    for (const x of actions) if (x.a.kind === "todo") addTodo(x.f, id, x.a.reason);
    if (!applicable.length) continue;
    if (!p) {
      for (const x of applicable) addTodo(x.f, id, "места нет в БД");
      continue;
    }
    const kinds = new Set(applicable.map((x) => JSON.stringify(x.a)));
    if (kinds.size > 1) {
      for (const x of applicable) addTodo(x.f, id, "противоречивые строки разметки — нужно ручное решение");
      continue;
    }
    const { f, a } = applicable[0]!;
    const src = `строка ${applicable.map((x) => x.f.line).join(",")}`;
    if (a.kind === "archive") change(id, src).archive = true;
    else if (a.kind === "booking") bookingRows.push(f);
    else if (a.kind === "move") {
      const bad = [a.category, ...a.extras].filter((c) => !categories.has(c));
      if (bad.length) addTodo(f, id, `категории ${bad.join(", ")} нет в БД`);
      else {
        const c = change(id, src);
        c.category = a.category;
        for (const e of a.extras) c.extras.add(e);
      }
    }
  }

  // --- Номера Booking: группа по базовому имени и близости, главная — запись объекта без суффикса ---
  const merges: CurateReport["merges"] = [];
  const bookingNotes: string[] = [];
  const bookingIds = new Set(bookingRows.map((f) => f.id));
  const byKey = new Map<string, { f: Finding; p: PlaceRow; base: string }[]>();
  for (const f of bookingRows) {
    const p = places.get(f.id);
    if (!p) {
      addTodo(f, f.id, "места нет в БД");
      continue;
    }
    // Повторный прогон: главная уже переименована — базовое имя из названия в разметке.
    const base = bookingBaseName(p.name.uk) ?? bookingBaseName(f.name);
    if (!base) {
      addTodo(f, f.id, "в названии нет суффикса типа номера");
      continue;
    }
    const key = normalizeName(base);
    byKey.set(key, [...(byKey.get(key) ?? []), { f, p, base }]);
  }
  const plainByKey = new Map<string, PlaceRow[]>();
  for (const p of places.values()) {
    if (bookingIds.has(p.id) || p.status === "archived" || changes.get(p.id)?.archive) continue;
    const key = normalizeName(p.name.uk);
    if (byKey.has(key)) plainByKey.set(key, [...(plainByKey.get(key) ?? []), p]);
  }
  for (const [key, rows] of byKey) {
    // Кластеры по близости (одиночная связь): одинаковое имя в разных пунктах — разные объекты.
    const clusters: (typeof rows)[] = [];
    for (const r of rows) {
      const hit = clusters.filter((c) => c.some((x) => haversine(x.p, r.p) <= radius));
      const merged = [r, ...hit.flat()];
      for (const h of hit) clusters.splice(clusters.indexOf(h), 1);
      clusters.push(merged);
    }
    for (const cluster of clusters) {
      const plain = (plainByKey.get(key) ?? []).filter((p) =>
        cluster.some((x) => haversine(x.p, p) <= radius),
      );
      let main: PlaceRow;
      if (plain.length) {
        main = pickMain(plain);
        if (plain.length > 1)
          bookingNotes.push(
            `«${main.name.uk}»: ${plain.length} записей без суффикса рядом — главная ${main.id}, остальные не тронуты`,
          );
      } else {
        main = pickMain(cluster.map((x) => x.p));
        const c = change(main.id, `строка ${cluster.find((x) => x.p.id === main.id)!.f.line} (Booking)`);
        c.name = cluster[0]!.base;
      }
      for (const x of cluster) {
        if (x.p.id === main.id) continue;
        change(x.p.id, `строка ${x.f.line} (Booking)`);
        merges.push({
          dup: x.p.id,
          main: main.id,
          dupName: x.p.name.uk,
          mainName: main.name.uk,
          kind: "booking",
        });
      }
    }
  }
  for (const m of decisionMerges)
    merges.push({
      dup: m.dup,
      main: m.main,
      dupName: nameOf(m.dup),
      mainName: nameOf(m.main),
      kind: "decision",
    });
  // Главная не должна сама уходить в архив или быть дублем и должна быть опубликована (в этой же транзакции).
  const dupSet = new Set(merges.map((m) => m.dup));
  const blockers = opts.guardMerges
    ? await mergeBlockers(trx, [...new Set(merges.flatMap((m) => [m.dup, m.main]))], places)
    : new Map<string, string[]>();
  for (const m of [...merges]) {
    const why = mergeSkipReason({
      main: m.main,
      mainMerging: dupSet.has(m.main) || Boolean(changes.get(m.main)?.archive),
      mainStatus: changes.get(m.main)?.restore ? "published" : places.get(m.main)?.status,
      blockers: [...(blockers.get(m.dup) ?? []), ...(blockers.get(m.main) ?? [])],
    });
    if (why) {
      merges.splice(merges.indexOf(m), 1);
      addTodo(findingsById.get(m.dup)?.[0], m.dup, why);
      continue;
    }
    const c = change(m.dup, "слияние");
    c.mergeInto = m.main;
    c.archive = true;
  }

  // Строка «слить» у главной записи выполнена слиянием её дубля — из «не применено» убрать.
  const mains = new Set(merges.map((m) => m.main));
  for (let i = todo.length - 1; i >= 0; i--)
    if (mains.has(todo[i]!.id) && /^слить/.test(todo[i]!.finding?.fix ?? "")) todo.splice(i, 1);

  // --- Населённый пункт по адресу Google (только явный другой пункт региона; «Яремче» — громада, не трогаем) ---
  for (const id of new Set(opts.localityIssueIds.map((i) => i.toLowerCase()))) {
    const p = places.get(id);
    const c = changes.get(id);
    if (!p || p.status === "archived" || c?.archive || c?.locality) continue;
    const at = p.lon != null && p.lat != null ? { lon: p.lon, lat: p.lat } : null;
    const code = localityFromAddress(p.address, at);
    const f = findingsById.get(id)?.[0];
    if (!code && priorLocality.has(id) && at) {
      // Прошлый прогон поставил пункт по адресу, который дальше 2 радиусов пункта, — вернуть пункт по расстоянию.
      const byDistance = localityOf(at, IMPORT_LOCALITIES, SEARCH_ZONES)?.code;
      if (byDistance && byDistance !== p.locality && localities.has(byDistance))
        change(id, "пункт по расстоянию (адрес Google дальше 2 радиусов пункта)").locality = byDistance;
      continue;
    }
    if (!code) {
      todo.push({
        line: null,
        id,
        name: p.name.uk,
        reason: `пункт: адрес «${p.address ?? ""}» не называет пункт однозначно (громада Яремче/код/нет) или пункт дальше 2 радиусов`,
      });
      continue;
    }
    if (code === p.locality || !localities.has(code)) continue;
    change(id, `пункт по адресу Google${f ? ` (строка ${f.line})` : ""}`).locality = code;
  }

  // --- Применение ---
  const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
  const counts: Record<string, number> = {
    move: 0,
    extra: 0,
    archive: 0,
    merge: 0,
    rename: 0,
    describe: 0,
    locality: 0,
  };
  const moves: Record<string, number> = {};
  const movedRefs: Record<string, number> = {
    favorites: 0,
    scenario_items: 0,
    scenario_alternatives: 0,
    user_plans_base: 0,
    qr_points: 0,
  };
  const leftRefs: CurateReport["leftRefs"] = [];
  const details: CurateReport["details"] = [];
  let changed = 0;
  for (const c of changes.values()) {
    const p = places.get(c.id)!;
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    const set: PlaceUpdate = {};
    const target = c.category ?? p.category;
    if (c.category && c.category !== p.category) {
      oldValues.category = p.category;
      newValues.category = c.category;
      set.category_id = categories.get(c.category);
      counts.move! += 1;
      moves[`${p.category} → ${c.category}`] = (moves[`${p.category} → ${c.category}`] ?? 0) + 1;
    }
    if (c.archive && p.status !== "archived") {
      oldValues.status = p.status;
      newValues.status = "archived";
      set.status = "archived";
      counts[c.mergeInto ? "merge" : "archive"]! += 1;
    }
    if (c.name && c.name !== p.name.uk) {
      oldValues.name = p.name;
      const name: LocalizedText = { ...p.name, uk: c.name };
      if (name.en && bookingBaseName(name.en)) name.en = bookingBaseName(name.en)!;
      newValues.name = name;
      set.name_i18n = name;
      counts.rename! += 1;
    }
    if (c.description && c.description !== p.description?.uk) {
      oldValues.description = p.description;
      const description: LocalizedText = { ...(p.description ?? {}), uk: c.description };
      newValues.description = description;
      set.description_i18n = description;
      counts.describe! += 1;
    }
    if (c.restore && p.status === "archived") {
      oldValues.status = p.status;
      newValues.status = "published";
      set.status = "published";
      counts.restore = (counts.restore ?? 0) + 1;
    }
    if (c.address && c.address !== p.address) {
      oldValues.address = p.addressI18n;
      const address: LocalizedText = { ...(p.addressI18n ?? {}), uk: c.address };
      newValues.address = address;
      set.address_i18n = address;
      counts.address = (counts.address ?? 0) + 1;
    }
    if (c.locality && c.locality !== p.locality) {
      oldValues.locality = p.locality;
      newValues.locality = c.locality;
      set.locality_id = localities.get(c.locality);
      counts.locality! += 1;
    }
    const extras = [...c.extras].filter((e) => e !== target);
    if (Object.keys(set).length) await trx.updateTable("places").set(set).where("id", "=", c.id).execute();
    if (c.category) {
      // Новая основная категория не дублируется доп.; доп. категории импорта относились к старой категории.
      const removed = await trx
        .deleteFrom("place_extra_categories")
        .where("place_id", "=", c.id)
        .where((eb) => eb.or([eb("category_id", "=", categories.get(target)!), eb("source", "=", "import")]))
        .returning(["category_id", "source"])
        .execute();
      const codeById = new Map([...categories].map(([code, id]) => [id, code] as const));
      const dropped = removed
        .filter((r) => r.source === "import" || r.category_id !== categories.get(target))
        .map((r) => `${codeById.get(r.category_id) ?? r.category_id}:${r.source}`);
      if (dropped.length) {
        newValues.removedExtraCategories = dropped;
        counts.extraRemoved = (counts.extraRemoved ?? 0) + dropped.length;
      }
    }
    if (extras.length) {
      const added = await trx
        .insertInto("place_extra_categories")
        .values(
          extras.map((e) => ({ place_id: c.id, category_id: categories.get(e)!, source: "manual" as const })),
        )
        .onConflict((oc) => oc.doNothing())
        .returning("category_id")
        .execute();
      if (added.length) {
        newValues.extraCategories = extras;
        counts.extra! += added.length;
      }
    }
    if (c.mergeInto) {
      const refs = await moveRefs(trx, c.id, c.mergeInto);
      for (const [k, v] of Object.entries(refs.moved)) movedRefs[k] = (movedRefs[k] ?? 0) + v;
      for (const [table, count] of Object.entries(refs.left))
        if (count) leftRefs.push({ dup: c.id, table, count });
      if (Object.values(refs.moved).some(Boolean)) newValues.movedRefs = refs.moved;
      // Уже слитый дубль (повторный прогон) без новых ссылок — не изменение.
      if (Object.keys(newValues).length) newValues.mergedInto = c.mergeInto;
    }
    if (!Object.keys(newValues).length) continue;
    changed += 1;
    details.push({ id: c.id, name: p.name.uk, old: oldValues, new: newValues, sources: c.sources });
    await audit.record(trx, {
      actor: { type: "system" },
      action: CURATE_ACTION,
      entityType: "place",
      entityId: c.id,
      oldValues,
      newValues,
      reason: `${reasonPrefix}: ${c.sources.join("; ")}`.slice(0, 1000),
    });
  }

  // --- Главная: какие дубли поглотила в этом прогоне (аудит у главной записи) ---
  const absorbedBy = new Map<string, string[]>();
  for (const d of details)
    if (typeof d.new.mergedInto === "string")
      absorbedBy.set(d.new.mergedInto, [...(absorbedBy.get(d.new.mergedInto) ?? []), d.id]);
  for (const [mainId, absorbed] of absorbedBy) {
    await audit.record(trx, {
      actor: { type: "system" },
      action: CURATE_ACTION,
      entityType: "place",
      entityId: mainId,
      oldValues: {},
      newValues: { absorbed },
      reason: `${reasonPrefix}: главная запись слияния, поглощены ${absorbed.join(", ")}`.slice(0, 1000),
    });
    counts.absorbed = (counts.absorbed ?? 0) + absorbed.length;
  }

  // --- Контакты: у главной нет телефона/сайта, у дубля есть — перенести (этот и прошлые прогоны) ---
  const dupsByMain = new Map<string, string[]>();
  for (const m of [...priorMerges, ...merges.map((x) => ({ dup: x.dup, main: x.main }))])
    if (!dupsByMain.get(m.main)?.includes(m.dup))
      dupsByMain.set(m.main, [...(dupsByMain.get(m.main) ?? []), m.dup]);
  const contactsMoved: CurateReport["contactsMoved"] = [];
  for (const [mainId, dupIds] of dupsByMain) {
    const main = places.get(mainId);
    if (!main || main.status === "archived") continue;
    // Порядок дублей — как при выборе главной (больше отзывов/фото — надёжнее контакты).
    // Дубль, возвращённый в published (restore: слияние было ошибкой), — не источник контактов.
    const dups = dupIds
      .map((d) => places.get(d))
      .filter(
        (d): d is PlaceRow =>
          Boolean(d) &&
          !changes.get(d!.id)?.restore &&
          (d!.status !== "published" || Boolean(changes.get(d!.id)?.mergeInto)),
      );
    const ordered: PlaceRow[] = [];
    const pool = [...dups];
    while (pool.length) {
      const best = pickMain(pool.map((d) => ({ ...d, status: "published" })));
      const i = pool.findIndex((d) => d.id === best.id);
      ordered.push(pool.splice(i, 1)[0]!);
    }
    const phoneFrom = main.phone ? undefined : ordered.find((d) => d.phone);
    // Ссылки агрегаторов бронирования у записей-номеров (bluepillow, freecancellations, booking…) — не сайт объекта.
    const siteFrom = main.website
      ? undefined
      : ordered.find((d) => d.website && !BOOKING_AGGREGATOR.test(d.website));
    if (!phoneFrom && !siteFrom) continue;
    const set: PlaceUpdate = {};
    const newValues: Record<string, unknown> = {};
    if (phoneFrom) set.phone = newValues.phone = phoneFrom.phone;
    if (siteFrom) set.website = newValues.website = siteFrom.website;
    newValues.contactsFrom = [...new Set([phoneFrom?.id, siteFrom?.id].filter(Boolean))];
    await trx.updateTable("places").set(set).where("id", "=", mainId).execute();
    await audit.record(trx, {
      actor: { type: "system" },
      action: CURATE_ACTION,
      entityType: "place",
      entityId: mainId,
      oldValues: {
        ...(phoneFrom ? { phone: main.phone } : {}),
        ...(siteFrom ? { website: main.website } : {}),
      },
      newValues,
      reason: `${reasonPrefix}: контакты слитого дубля на главную (у главной их не было)`,
    });
    contactsMoved.push({
      main: mainId,
      name: main.name.uk,
      from: (phoneFrom ?? siteFrom)!.id,
      ...(phoneFrom?.phone ? { phone: phoneFrom.phone } : {}),
      ...(siteFrom?.website ? { website: siteFrom.website } : {}),
    });
    counts.contacts = (counts.contacts ?? 0) + 1;
  }

  // --- Сценарии: место пункта, архивированное чисткой, — на ближайшую опубликованную альтернативу пункта;
  // из альтернатив убрать само место пункта, повторы и места, архивированные чисткой ---
  const curatedArchived = new Set([
    ...priorArchived,
    ...[...changes.values()].filter((c) => c.archive).map((c) => c.id),
  ]);
  const scenarioFixes: CurateReport["scenarioFixes"] = [];
  const archivedInScenarios: CurateReport["archivedInScenarios"] = [];
  const statusNow = new Map(
    (await trx.selectFrom("places").select(["id", "status"]).execute()).map((r) => [r.id, r.status] as const),
  );
  const items = await trx
    .selectFrom("scenario_items")
    .select(["id", "scenario_id", "place_id", "alternatives"])
    .orderBy("scenario_id")
    .orderBy("day_no")
    .orderBy("position")
    .execute();
  // Места пунктов сценария: замена не должна повторять место, уже стоящее в этом сценарии.
  const usedInScenario = new Map<string, Map<string, number>>();
  for (const it of items) {
    const m = usedInScenario.get(it.scenario_id) ?? new Map<string, number>();
    m.set(it.place_id, (m.get(it.place_id) ?? 0) + 1);
    usedInScenario.set(it.scenario_id, m);
  }
  const stuck = new Map<string, number>();
  for (const it of items) {
    const used = usedInScenario.get(it.scenario_id)!;
    let placeId = it.place_id;
    let replaced: { from: string; to: string } | undefined;
    let why = "";
    const archived = curatedArchived.has(placeId) && statusNow.get(placeId) !== "published";
    // Повтор места в сценарии (в т.ч. после замены прошлым прогоном) — второй и далее пункт меняется.
    const repeated = (used.get(placeId) ?? 0) > 1;
    if (archived || repeated) {
      const from = places.get(placeId);
      const candidates = it.alternatives
        .filter((a) => a !== placeId && statusNow.get(a) === "published" && places.has(a) && !used.has(a))
        .map((a) => places.get(a)!)
        .sort((a, b) => (from ? haversine(from, a) - haversine(from, b) : 0));
      if (candidates[0]) {
        replaced = { from: placeId, to: candidates[0].id };
        used.set(placeId, (used.get(placeId) ?? 1) - 1);
        if (!used.get(placeId)) used.delete(placeId);
        placeId = candidates[0].id;
        used.set(placeId, 1);
        why = archived
          ? "место пункта в архиве — замена на ближайшую опубликованную альтернативу"
          : "место повторяется в сценарии — замена на ближайшую опубликованную альтернативу";
      } else if (archived) stuck.set(placeId, (stuck.get(placeId) ?? 0) + 1);
    }
    const alts: string[] = [];
    for (const a of it.alternatives)
      if (a !== placeId && !alts.includes(a) && !(curatedArchived.has(a) && statusNow.get(a) !== "published"))
        alts.push(a);
    const removedAlternatives = it.alternatives.filter((a) => !alts.includes(a));
    if (!replaced && !removedAlternatives.length) continue;
    await trx
      .updateTable("scenario_items")
      .set({ place_id: placeId, alternatives: alts })
      .where("id", "=", it.id)
      .execute();
    scenarioFixes.push({ item: it.id, scenario: it.scenario_id, replaced, removedAlternatives });
    await audit.record(trx, {
      actor: { type: "system" },
      action: CURATE_ACTION,
      entityType: "scenario_item",
      entityId: it.id,
      oldValues: { placeId: it.place_id, alternatives: it.alternatives },
      newValues: { placeId, alternatives: alts },
      reason: `${reasonPrefix}: ${why || "чистка альтернатив (само место пункта, повторы, архив чистки)"}`,
    });
  }
  for (const [id, n] of stuck) archivedInScenarios.push({ id, name: nameOf(id), items: n });

  const after = await publishedByCategory(trx);
  const roomAfter = await publishedRoomSuffix(trx);
  const peakIds = [...changes.values()].filter((c) => c.category === "peaks").map((c) => c.id);
  const peaksCheck = peakIds.length
    ? await trx
        .selectFrom("places as p")
        .innerJoin("categories as c", "c.id", "p.category_id")
        .select(["p.id", sql<string>`p.name_i18n ->> 'uk'`.as("name"), "c.code as category", "p.status"])
        .where("p.id", "in", peakIds)
        .execute()
    : [];
  log(`Изменено мест: ${changed}`);
  return {
    dryRun: opts.dryRun,
    changedPlaces: changed,
    details,
    counts,
    moves,
    todo,
    merges,
    contactsMoved,
    leftRefs,
    movedRefs,
    archivedInScenarios,
    scenarioFixes,
    bookingNotes,
    publishedByCategory: { before, after },
    publishedRoomSuffix: { before: roomBefore, after: roomAfter },
    peaksCheck,
    lines,
  };
}

/**
 * Таблицы со ссылкой на место, которые слияние не переносит (данные партнёра, брони, отзывы, медиа, расписание,
 * теги…): при осторожном слиянии (guardMerges) их наличие у любой стороны — причина не сливать автоматически.
 * analytics_events не блокирует.
 */
export const MERGE_BLOCKING_TABLES = [
  "bookings",
  "reviews",
  "review_eligibilities",
  "place_review_ratings",
  "host_modules",
  "offers",
  "resources",
  "service_requests",
  "moderation_cases",
  "promotions",
  "partner_phone_consents",
  "entry_contexts",
  "place_media",
  "place_schedules",
  "place_schedule_exceptions",
  "place_tags",
  "place_badge_events",
  "place_cover_photos",
] as const;

/** Почему слияние пропускается (в todo): главная сама уходит, не опубликована, есть блокеры осторожного режима. */
export function mergeSkipReason(m: {
  main: string;
  mainMerging: boolean;
  mainStatus: string | undefined;
  blockers: readonly string[];
}): string | null {
  if (m.mainMerging) return `главная запись ${m.main} сама архивируется/сливается`;
  if (m.mainStatus !== "published")
    return `главная запись ${m.main} не опубликована (${m.mainStatus ?? "нет в БД"})`;
  if (m.blockers.length) return `слияние не автоматическое: ${m.blockers.join(", ")}`;
  return null;
}

/** Блокеры автоматического слияния по самому месту: место партнёра, источник не google. */
export function placeMergeBlockers(p: {
  id: string;
  organizationId: string | null;
  source: string;
}): string[] {
  const out: string[] = [];
  if (p.organizationId) out.push(`${p.id}: место партнёра`);
  if (p.source !== "google") out.push(`${p.id}: источник ${p.source}`);
  return out;
}

/** Почему место нельзя сливать автоматически: организация партнёра, источник не google, ссылки (таблица ×n). */
async function mergeBlockers(
  trx: Db,
  ids: readonly string[],
  places: ReadonlyMap<string, PlaceRow>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const add = (id: string, why: string) => out.set(id, [...(out.get(id) ?? []), why]);
  for (const id of ids) {
    const p = places.get(id);
    if (p) for (const why of placeMergeBlockers(p)) add(id, why);
  }
  if (!ids.length) return out;
  for (const table of MERGE_BLOCKING_TABLES) {
    const rows = await trx
      .selectFrom(table)
      .select(["place_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("place_id", "in", [...ids])
      .groupBy("place_id")
      .execute();
    for (const r of rows) if (r.place_id) add(r.place_id, `${r.place_id}: ${table} ×${Number(r.n)}`);
  }
  return out;
}

/** Перенос ссылок дубля на главную запись; что перенести нельзя — счётчики оставшихся. */
async function moveRefs(
  trx: Db,
  dup: string,
  main: string,
): Promise<{ moved: Record<string, number>; left: Record<string, number> }> {
  const moved: Record<string, number> = {};
  // Избранное: у пользователя может уже быть главная — UNIQUE (user_id, place_id).
  const favs = await trx.selectFrom("favorites").select("user_id").where("place_id", "=", dup).execute();
  if (favs.length) {
    await trx
      .insertInto("favorites")
      .values(favs.map((f) => ({ user_id: f.user_id, place_id: main })))
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx.deleteFrom("favorites").where("place_id", "=", dup).execute();
  }
  moved.favorites = favs.length;
  const items = await trx
    .updateTable("scenario_items")
    .set({ place_id: main })
    .where("place_id", "=", dup)
    .returning("id")
    .execute();
  moved.scenario_items = items.length;
  const withAlt = await trx
    .selectFrom("scenario_items")
    .select(["id", "place_id", "alternatives"])
    .where((eb) =>
      eb.or([
        sql<boolean>`${dup}::uuid = any(alternatives)`,
        ...(items.length
          ? [
              eb(
                "id",
                "in",
                items.map((i) => i.id),
              ),
            ]
          : []),
      ]),
    )
    .execute();
  for (const it of withAlt) {
    const alts: string[] = [];
    for (const a of it.alternatives) {
      const v = a === dup ? main : a;
      if (v !== it.place_id && !alts.includes(v)) alts.push(v);
    }
    await trx.updateTable("scenario_items").set({ alternatives: alts }).where("id", "=", it.id).execute();
  }
  moved.scenario_alternatives = withAlt.length;
  const plans = await trx
    .updateTable("user_plans")
    .set({ base_place_id: main })
    .where("base_place_id", "=", dup)
    .returning("id")
    .execute();
  moved.user_plans_base = plans.length;
  const qr = await trx
    .updateTable("qr_points")
    .set({ place_id: main })
    .where("place_id", "=", dup)
    .returning("id")
    .execute();
  moved.qr_points = qr.length;

  const count = async (
    table:
      | "host_modules"
      | "bookings"
      | "reviews"
      | "resources"
      | "service_requests"
      | "offers"
      | "moderation_cases"
      | "promotions"
      | "review_eligibilities"
      | "partner_phone_consents"
      | "entry_contexts",
  ) =>
    Number(
      (
        await trx
          .selectFrom(table)
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("place_id", "=", dup)
          .executeTakeFirstOrThrow()
      ).n,
    );
  const left: Record<string, number> = {};
  for (const t of [
    "host_modules",
    "bookings",
    "reviews",
    "resources",
    "service_requests",
    "offers",
    "moderation_cases",
    "promotions",
    "review_eligibilities",
    "partner_phone_consents",
    "entry_contexts",
  ] as const)
    left[t] = await count(t);
  const inPlanItems = await trx
    .selectFrom("user_plans")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where(sql<boolean>`items::text like ${`%${dup}%`}`)
    .executeTakeFirstOrThrow();
  left.user_plans_items = Number(inPlanItems.n);
  return { moved, left };
}
