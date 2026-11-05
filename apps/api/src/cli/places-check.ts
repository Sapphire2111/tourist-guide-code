// CLI проверки опубликованных мест: вероятные дубли и места вне региона.
//   pnpm --filter @tg/api places:check -- [--region test-region] [--csv <out.csv>] [--max-distance 80]
//     [--explicit-distance 30] [--write]
// Без --write — отчёт: в БД ничего не сохраняется (план считается тем же curatePlaces в транзакции с откатом).
// --write в одной транзакции (tenant-контекст, аудит place.curate с причиной пары):
//   - явные дубли: главная — опубликованная с большим числом отзывов/фото; дубль → archived (mergedInto в аудите),
//     у главной — аудит со списком поглощённых; на главную переносятся избранное, пункты сценариев и их
//     альтернативы, «где живу» в планах, QR-точки, телефон/сайт (если у главной их нет); пункт сценария с
//     повтором места меняется на ближайшую опубликованную альтернативу;
//   - слияние пропускается (в «не применено»), если у любой стороны место партнёра, источник не google или есть
//     данные, которые слияние не переносит (брони, отзывы, медиа, расписание, теги… — MERGE_BLOCKING_TABLES);
//   - явные «вне региона» — archived.
// Спорные — только в отчёт/CSV.
// Только DATABASE_URL — роль приложения без BYPASSRLS.
import { writeFile } from "node:fs/promises";
import { sql } from "kysely";
import {
  createDatabase,
  lonLatOf,
  readDbRoleStatus,
  regionContext,
  withTenant,
  type Db,
} from "../db/index.js";
import { curatePlaces, pickMain } from "../places-curate/apply.js";
import {
  DEFAULT_TOWNS,
  explicitGroups,
  findDuplicatePairs,
  findOutOfRegion,
  type CheckPlace,
  type CoverageCircle,
} from "../places-curate/checks.js";
import { CurateInputError, normalizeName, type Decision } from "../places-curate/rules.js";
import {
  IMPORT_LOCALITIES,
  REGION_POSTCODE_PREFIXES,
  SEARCH_ZONES,
  TARGETED_LOCALITIES,
} from "../places-import/config.js";

/** Радиус пункта из БД, которого нет в настройках импорта, м. */
const DEFAULT_LOCALITY_RADIUS_M = 4000;

type Args = {
  region: string;
  csv?: string;
  maxDistanceM: number;
  explicitDistanceM: number;
  write: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { region: "test-region", maxDistanceM: 80, explicitDistanceM: 30, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new CurateInputError(`${a}: нужно значение`);
      return v;
    };
    const meters = () => {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new CurateInputError(`${a}: нужно число метров > 0`);
      return n;
    };
    if (a === "--") continue;
    else if (a === "--write") out.write = true;
    else if (a === "--region") out.region = value();
    else if (a === "--csv") out.csv = value();
    else if (a === "--max-distance") out.maxDistanceM = meters();
    else if (a === "--explicit-distance") out.explicitDistanceM = meters();
    else throw new CurateInputError(`Неизвестный аргумент ${a}`);
  }
  if (out.explicitDistanceM > out.maxDistanceM)
    throw new CurateInputError("--explicit-distance не может быть больше --max-distance");
  return out;
}

const csvCell = (v: string | number | null | undefined) => {
  const s = String(v ?? "");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

type Row = CheckPlace & { status: string; description: { uk: string } | null; hasAi: boolean };

async function load(
  db: Db,
  regionCode: string,
): Promise<{ places: Row[]; circles: CoverageCircle[]; towns: Set<string> }> {
  const region = await db
    .selectFrom("regions")
    .select("id")
    .where("code", "=", regionCode)
    .executeTakeFirst();
  if (!region) throw new CurateInputError(`Регион ${regionCode} не найден`);
  return withTenant(db, regionContext(region.id), async (trx) => {
    const raw = await trx
      .selectFrom("places as p")
      .innerJoin("categories as c", "c.id", "p.category_id")
      .leftJoin("place_enrichments as e", "e.place_id", "p.id")
      .leftJoin("localities as l", "l.id", "p.locality_id")
      .select([
        "p.id",
        sql<string>`p.name_i18n ->> 'uk'`.as("name"),
        "p.description_i18n",
        sql<string | null>`p.address_i18n ->> 'uk'`.as("address"),
        "c.code as category",
        "l.code as locality",
        "p.status",
        (eb) => lonLatOf(eb.ref("p.location")).as("at"),
        sql<string | null>`e.google ->> 'ratingCount'`.as("rc"),
        sql<number>`coalesce(jsonb_array_length(e.google -> 'photos'), 0)`.as("photos"),
        sql<boolean>`e.ai_summary_uk is not null`.as("ai"),
      ])
      .where("p.status", "=", "published")
      .execute();
    const localities = await trx
      .selectFrom("localities")
      .select(["code", "name_i18n", (eb) => lonLatOf(eb.ref("location")).as("at")])
      .execute();
    const radius = new Map([...IMPORT_LOCALITIES, ...TARGETED_LOCALITIES].map((l) => [l.code, l.radiusM]));
    const circles: CoverageCircle[] = [
      ...localities.flatMap((l) =>
        l.at ? [{ code: l.code, at: l.at, radiusM: radius.get(l.code) ?? DEFAULT_LOCALITY_RADIUS_M }] : [],
      ),
      ...SEARCH_ZONES.map((z) => ({ code: `zone:${z.code}`, at: z.at, radiusM: z.radiusM })),
    ];
    // Названия пунктов из БД (uk/en, части «Поляниця (Буковель)») — сегменты адреса, которые не улица.
    const towns = new Set(DEFAULT_TOWNS);
    for (const l of localities)
      for (const n of Object.values(l.name_i18n ?? {}))
        if (typeof n === "string")
          for (const part of [n, ...n.split(/[()]/)]) {
            const t = normalizeName(part);
            if (t) towns.add(t);
          }
    return {
      circles,
      towns,
      places: raw.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        locality: r.locality,
        address: r.address,
        at: r.at,
        ratingCount: Number(r.rc ?? 0) || 0,
        photos: Number(r.photos) || 0,
        status: r.status,
        description: r.description_i18n,
        hasAi: Boolean(r.ai),
      })),
    };
  });
}

let db: Db | undefined;
try {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim();
  if (!url)
    throw new CurateInputError("Не задан DATABASE_URL (роль приложения; DATABASE_MIGRATION_URL не подходит)");
  db = createDatabase({ connectionString: url, maxConnections: 1 });
  const role = await readDbRoleStatus(db);
  if (role.bypassesRls)
    throw new CurateInputError(
      `Роль ${role.role} обходит RLS — нужна роль приложения (DATABASE_URL), не владелец схемы`,
    );
  const { places, circles, towns } = await load(db, args.region);
  const byId = new Map(places.map((p) => [p.id, p]));
  const pairs = findDuplicatePairs(places, {
    maxDistanceM: args.maxDistanceM,
    explicitDistanceM: args.explicitDistanceM,
    knownTowns: towns,
  });
  const { groups, split } = explicitGroups(pairs);
  const outside = findOutOfRegion(places, circles, { postcodePrefixes: REGION_POSTCODE_PREFIXES });
  console.log(
    `Опубликованных мест: ${places.length}; пар-дублей: ${pairs.length} ` +
      `(явных групп ${groups.length}, групп с неполными явными связями ${split.length}); ` +
      `вне региона: ${outside.length} (явных ${outside.filter((o) => o.verdict === "explicit").length}); ` +
      `режим: ${args.write ? `запись в ${args.region}` : "отчёт (без --write ничего не пишется)"}`,
  );

  const decisions: Decision[] = [];
  console.log("\nЯвные дубли (главная ← дубли):");
  for (const g of groups) {
    const main = pickMain(g.map((p) => byId.get(p.id)!));
    const dups = g.filter((p) => p.id !== main.id);
    console.log(
      `  ${main.name} (${main.id}, ${main.category}) ← ${dups.map((d) => `${d.name} (${d.id})`).join(", ")}`,
    );
    for (const d of dups) {
      const pair = pairs.find(
        (p) => (p.a.id === d.id && p.b.id === main.id) || (p.b.id === d.id && p.a.id === main.id),
      );
      decisions.push({
        kind: "merge",
        id: d.id,
        mainId: main.id,
        note: `places:check — явный дубль «${main.name}»: ${pair?.reason ?? "группа явных пар"}`,
      });
    }
  }
  const inGroups = new Set(groups.flat().map((p) => p.id));
  console.log("\nСпорные дубли:");
  for (const p of pairs)
    if (p.verdict === "disputed" || !inGroups.has(p.a.id) || !inGroups.has(p.b.id))
      console.log(`  ${p.a.name} (${p.a.id}) ~ ${p.b.name} (${p.b.id}): ${p.reason}`);
  console.log("\nВне региона:");
  for (const o of outside) {
    console.log(
      `  [${o.verdict === "explicit" ? "явно" : "спорно"}] ${o.place.name} (${o.place.id}, ${o.place.category}): ${o.reason}`,
    );
    if (o.verdict === "explicit" && !decisions.some((d) => d.id === o.place.id))
      decisions.push({ kind: "archive", id: o.place.id, note: `places:check — вне региона: ${o.reason}` });
  }

  if (args.csv) {
    const head = [
      "тип",
      "вердикт",
      "id_a",
      "место_a",
      "категория_a",
      "адрес_a",
      "id_b",
      "место_b",
      "категория_b",
      "адрес_b",
      "причина",
    ];
    const rows: (string | number | null)[][] = [
      ...pairs.map((p) => [
        "дубль",
        p.verdict === "explicit" && inGroups.has(p.a.id) && inGroups.has(p.b.id) ? "явный" : "спорный",
        p.a.id,
        p.a.name,
        p.a.category,
        p.a.address,
        p.b.id,
        p.b.name,
        p.b.category,
        p.b.address,
        p.reason,
      ]),
      ...outside.map((o) => [
        "вне региона",
        o.verdict === "explicit" ? "явный" : "спорный",
        o.place.id,
        o.place.name,
        o.place.category,
        o.place.address,
        "",
        o.nearest,
        "",
        "",
        o.reason,
      ]),
    ];
    await writeFile(
      args.csv,
      `\uFEFF${[head, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`,
    );
    console.log(`\nCSV: ${args.csv}`);
  }

  // План записи — тем же curatePlaces: без --write транзакция откатывается (план = результат).
  if (decisions.length) {
    const report = await curatePlaces(db, {
      regionCode: args.region,
      findings: [],
      decisions,
      localityIssueIds: [],
      dryRun: !args.write,
      reason: "проверка дублей/региона",
      guardMerges: true,
    });
    console.log(
      `\n${args.write ? "Записано" : "План (откат)"}: изменено мест ${report.changedPlaces}, ` +
        `${JSON.stringify(report.counts)}, ссылок перенесено ${JSON.stringify(report.movedRefs)}`,
    );
    for (const l of report.leftRefs) console.log(`  осталось на дубле ${l.dup}: ${l.table} ×${l.count}`);
    for (const f of report.scenarioFixes)
      console.log(
        `  пункт сценария ${f.item} (${f.scenario}): ` +
          [
            f.replaced ? `замена ${f.replaced.from} → ${f.replaced.to}` : null,
            f.removedAlternatives.length ? `убраны альтернативы ${f.removedAlternatives.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; "),
      );
    for (const c of report.contactsMoved)
      console.log(
        `  контакты → ${c.name} (${c.main}) из ${c.from}: ` +
          [c.phone && `телефон ${c.phone}`, c.website && `сайт ${c.website}`].filter(Boolean).join(", "),
      );
    for (const t of report.todo) console.log(`  не применено: ${t.name} (${t.id}) — ${t.reason}`);
  } else console.log("\nЯвных изменений нет.");
} catch (e) {
  if (e instanceof CurateInputError) console.error(e.message);
  else console.error(e);
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
