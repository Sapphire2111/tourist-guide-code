// Проверки качества мест (CLI places:check): вероятные дубли (категория + расстояние + адрес/название) и места
// вне региона (по кругам пунктов и зон поиска — полигона региона в БД нет). Только чистые функции: решение
// «явный/спорный» принимает этот модуль, запись (слияние/архив) — places:curate (apply.ts) с аудитом place.curate.

import type { LonLat } from "../db/index.js";
import { haversineMeters } from "../places-import/mapping.js";
import { normalizeName } from "./rules.js";

/** Место для проверок: основная категория, точка, адрес uk и признаки качества данных. */
export type CheckPlace = {
  id: string;
  name: string;
  category: string;
  address: string | null;
  at: LonLat | null;
  /** Код населённого пункта места; null — место намеренно вне пунктов (точечный импорт для сценариев). */
  locality?: string | null;
  ratingCount: number;
  photos: number;
};

/**
 * Родственные категории: один объект Google мог попасть в любую из них (садиба/готель, кафе/ресторан).
 * Дубль в родственной (не той же) категории — только спорный: слияние меняет категорию, решает человек.
 */
export const RELATED_CATEGORY_GROUPS: readonly (readonly string[])[] = [
  ["hotels", "sadyby"],
  ["restaurants", "cafes", "fast-food", "kolyby"],
  ["ski-lifts", "ski-resorts", "ski-schools"],
  ["ski-rental", "ski-shops", "gear-rental"],
  ["sights", "museums", "nature", "kids", "entertainment", "excursions", "active", "adult-fun"],
  ["spa", "chany"],
  ["stores", "groceries", "markets", "souvenirs"],
  ["car-service", "car-wash", "tow-trucks"],
];

export function categoriesRelated(a: string, b: string): boolean {
  return a === b || RELATED_CATEGORY_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

/** Нормализованный адрес: улица (последнее слово названия — фамилия/имя улицы) и номер дома. */
export type NormalizedAddress = { street: string | null; number: string | null };

const APOSTROPHES = /[«»"“”„'‘’ʼʹ`]/g;
/** Сегменты адреса, которые не различают места: страна, область, район, громада, индекс, plus-код. */
const NOISE_SEGMENT =
  /^(україна|украина|ukraine|.*област[ьі]|.*обл\.?|.*oblast|.*район|.*р-н\.?|.*міська рада|.*громада|\d{5}|[0-9a-z]{4}\+[0-9a-z]{2,3}(\s.*)?)$/i;
/** Префиксы местности, а не улицы: «урочище Вишня», «участок Щивки» — улица только вместе с номером. */
const AREA_PREFIX = /^(урочище|ур|участок|ділянка)(\.\s*|\s+)/i;
const STREET_PREFIX =
  /^(вулиця|вул|ул|улица|street|st|провулок|пров|переулок|пер|площа|пл|проспект|просп|урочище|ур|участок|ділянка|дорога|траса|шосе)(\.\s*|\s+)/i;
/** «буд. 1», «будинок 5а» — номер дома; «прим. 5», «кв. 3», «офіс 2» — часть дома, не различает места. */
const BUILDING = /^(буд|будинок|д)\.?\s*(\d.*)$/u;
const PREMISES = /^(прим|приміщення|кв|квартира|офіс|оф|корпус|корп|секція)(\.|\s|$)/u;
const HOUSE_NUMBER = /^\d+\s*[\p{L}]?(\s*[/-]\s*\d+[\p{L}]?)?$/u;
const TRAILING_NUMBER = /\s+(\d+\s*[\p{L}]?(\s*[/-]\s*\d+[\p{L}]?)?)$/u;

/**
 * Разбор адреса uk из Google: «вулиця Михайла Грушевського, 12а, Яремче» → { street: «грушевського», number: «12а» }.
 * Сегменты-пункты без улицы («Яремче», «Поляниця») улицы не дают: такой адрес слабый и для совпадения не годится.
 * `knownTowns` — нормализованные названия пунктов (их сегменты отбрасываются).
 */
export function normalizeAddress(
  address: string | null | undefined,
  knownTowns: ReadonlySet<string> = DEFAULT_TOWNS,
): NormalizedAddress {
  if (!address) return { street: null, number: null };
  const segments = address
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/ё/g, "е")
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s && !NOISE_SEGMENT.test(s));
  let street: string | null = null;
  let number: string | null = null;
  let area = false;
  for (const seg of segments) {
    const town = seg.replace(/^(м|с|смт|село|селище|місто)\.?\s+/, "");
    if (knownTowns.has(town)) continue;
    if (PREMISES.test(seg)) continue;
    const building = BUILDING.exec(seg);
    if (building && HOUSE_NUMBER.test(building[2]!)) {
      number ??= building[2]!.replace(/\s+/g, "");
      continue;
    }
    if (HOUSE_NUMBER.test(seg)) {
      number ??= seg.replace(/\s+/g, "");
      continue;
    }
    if (street) continue;
    let s = seg;
    const tail = TRAILING_NUMBER.exec(s);
    if (tail) {
      number ??= tail[1]!.replace(/\s+/g, "");
      s = s.slice(0, tail.index);
    }
    if (AREA_PREFIX.test(s)) area = true;
    const hadPrefix = STREET_PREFIX.test(s);
    s = s.replace(STREET_PREFIX, "").trim();
    const words = s.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
    // Без префикса улицы сегмент — улица, только если это не одно слово-ориентир без номера («Навпроти садиба…»).
    if (words.length && (hadPrefix || tail || words.length <= 3)) street = words.at(-1)!;
  }
  // «урочище X» без номера дома — местность, не адрес.
  if (area && !number) street = null;
  return { street, number };
}

export const DEFAULT_TOWNS: ReadonlySet<string> = new Set([
  "яремче",
  "татарів",
  "микуличин",
  "поляниця",
  "поляница",
  "буковель",
  "яблуниця",
  "яблуница",
  "ворохта",
  "косів",
  "дора",
]);

/** Адреса совпадают: одна улица и один номер дома. Адрес без улицы или без номера не совпадает ни с чем. */
export function sameAddress(a: NormalizedAddress, b: NormalizedAddress): boolean {
  if (!a.street || !b.street || !a.number || !b.number) return false;
  return a.street === b.street && a.number === b.number;
}

/** Слова, которые не несут смысла для сравнения названий: предлоги, союзы, пункты. */
const STOP_WORDS = new Set(
  (
    "в у на та і й и з біля поруч the of and " +
    "яремче яремчі татарів татарові микуличин микуличині поляниця поляниці буковель буковелі яблуниця яблуниці " +
    "ворохта ворохті косів косові"
  ).split(" "),
);

/**
 * Слова-типы: в сравнении остаются и различают объекты. «Банкомат Ощадбанк» и «Ощадбанк» (відділення) — разные
 * точки: тип есть только в одном названии — пара не явная.
 */
const TYPE_WORDS = new Set(
  (
    "банкомат банкомати відділення поштомат термінал аптека таксі трансфер прокат оренда чан чани баня сауна " +
    "спа spa готель гостиница отель hotel хостел hostel садиба усадьба котедж котеджі cottage вілла villa " +
    "апартаменти apartments кафе ресторан restaurant колиба бар піцерія кавярня магазин маркет супермаркет " +
    "ринок підйомник витяг школа музей atm bankomat bankomaty отделение otdelenie viddilennia viddilennya"
  ).split(" "),
);

const KIOSK_WORDS = new Set(
  "банкомат банкомати atm bankomat bankomaty термінал терминал поштомат почтомат".split(" "),
);

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(x: string, y: string): number {
  const ga = bigrams(x);
  const gb = bigrams(y);
  let common = 0;
  let total = 0;
  for (const [g, n] of ga) {
    common += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total ? (2 * common) / total : 0;
}

/** Сравнение названий: похожесть и причины, по которым пара не может быть явной. */
export type NameComparison = {
  /** 0…1: Дайс по биграммам слов без предлогов, пунктов и слов-типов; вложенность ≥ 2 слов — 0.9. */
  similarity: number;
  /** Причины «не явная»: разные слова-типы, разные числа, только общие слова, вложенность. Пусто — можно явно. */
  blockers: string[];
};

const nameWords = (s: string) =>
  normalizeName(s)
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w));

export function compareNames(a: string, b: string): NameComparison {
  const wa = nameWords(a);
  const wb = nameWords(b);
  const blockers: string[] = [];
  const types = (ws: string[]) => new Set(ws.filter((w) => TYPE_WORDS.has(w)));
  const ta = types(wa);
  const tb = types(wb);
  const typeDiff = [...ta].filter((w) => !tb.has(w)).concat([...tb].filter((w) => !ta.has(w)));
  if (typeDiff.length) blockers.push(`разные типы в названиях (${typeDiff.join(", ")})`);
  const nums = (ws: string[]) =>
    ws
      .flatMap((w) => w.match(/\d+/g) ?? [])
      .sort()
      .join(",");
  if (nums(wa) !== nums(wb))
    blockers.push(`разные номера в названиях (${nums(wa) || "—"} / ${nums(wb) || "—"})`);
  // Похожесть — по словам без типов: «Садиба Форесок» и «Садиба Топірець» не похожи из-за общего «садиба»
  // (типы сравниваются отдельно — блокер).
  const x = wa.filter((w) => !TYPE_WORDS.has(w)).join(" ");
  const y = wb.filter((w) => !TYPE_WORDS.has(w)).join(" ");
  if (!x || !y) {
    blockers.push("в названии только общие слова");
    return { similarity: Math.min(0.5, dice(wa.join(" "), wb.join(" "))), blockers };
  }
  if (x === y) return { similarity: 1, blockers };
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (` ${long} `.includes(` ${short} `)) {
    blockers.push("одно название внутри другого");
    return { similarity: 0.9, blockers };
  }
  return { similarity: dice(x, y), blockers };
}

/** Похожесть названий 0…1 (см. compareNames). */
export function nameSimilarity(a: string, b: string): number {
  return compareNames(a, b).similarity;
}

export type DuplicateOptions = {
  /** Наибольшее расстояние пары, м (по умолчанию 80). */
  maxDistanceM?: number;
  /** Явный дубль — не дальше, м (по умолчанию 30). */
  explicitDistanceM?: number;
  knownTowns?: ReadonlySet<string>;
};

export type DuplicatePair = {
  a: CheckPlace;
  b: CheckPlace;
  distanceM: number;
  sameAddress: boolean;
  similarity: number;
  /** explicit — сливать автоматически (--write); disputed — в отчёт для человека. */
  verdict: "explicit" | "disputed";
  reason: string;
};

/**
 * Вероятные дубли: родственные категории, расстояние ≤ maxDistanceM и одно из: похожие названия ≥ 0.75;
 * одинаковый адрес (улица + номер) и названия хоть немного похожи (≥ 0.3); тот же адрес, та же категория и ≤ 15 м
 * (одна точка Google при разных названиях). Явный дубль: та же категория, ≤ explicitDistanceM, у названий нет
 * блокеров (compareNames: разные типы/номера, только общие слова, вложенность) и либо адрес совпал и названия
 * похожи (≥ 0.5), либо названия почти одинаковы (≥ 0.9). Остальное — спорное.
 */
export function findDuplicatePairs(
  places: readonly CheckPlace[],
  opts: DuplicateOptions = {},
): DuplicatePair[] {
  const maxD = opts.maxDistanceM ?? 80;
  const explicitD = opts.explicitDistanceM ?? 30;
  const towns = opts.knownTowns ?? DEFAULT_TOWNS;
  const located = places
    .filter((p): p is CheckPlace & { at: LonLat } => p.at != null)
    .map((p) => ({ p, addr: normalizeAddress(p.address, towns) }))
    .sort((x, y) => x.p.at.lat - y.p.at.lat);
  // Окно по широте: 1° ≈ 111 км.
  const latWindow = maxD / 111_000;
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < located.length; i++) {
    const x = located[i]!;
    for (let j = i + 1; j < located.length; j++) {
      const y = located[j]!;
      if (y.p.at.lat - x.p.at.lat > latWindow) break;
      if (!categoriesRelated(x.p.category, y.p.category)) continue;
      const d = haversineMeters(x.p.at, y.p.at);
      if (d > maxD) continue;
      const same = sameAddress(x.addr, y.addr);
      const names = compareNames(x.p.name, y.p.name);
      const sim = names.similarity;
      const sameCategory = x.p.category === y.p.category;
      // Та же улица, у обоих без номера (вулиця Грушевського, Яремче) и похожие названия — только спорная пара.
      const sameStreetNoNumber =
        x.addr.street != null && x.addr.street === y.addr.street && !x.addr.number && !y.addr.number;
      if (
        sim < 0.75 &&
        !(same && (sim >= 0.3 || (sameCategory && d <= 15))) &&
        !(sameStreetNoNumber && sameCategory && sim >= 0.5 && d <= explicitD)
      )
        continue;
      // Банкоматы/терминалы без адреса у обоих — одинаковые названия у разных точек сети: не явная пара.
      const kiosk = (n: string) => nameWords(n).some((w) => KIOSK_WORDS.has(w));
      const kioskNoAddr = (kiosk(x.p.name) || kiosk(y.p.name)) && !same;
      const explicit =
        !kioskNoAddr &&
        sameCategory &&
        d <= explicitD &&
        !names.blockers.length &&
        ((same && sim >= 0.5) || sim >= 0.9);
      const reason = [
        `${Math.round(d)} м`,
        same ? "адрес совпал" : sameStreetNoNumber ? "та же улица без номера" : "адрес разный/неполный",
        `названия ${sim.toFixed(2)}`,
        sameCategory ? "категория та же" : `категории ${x.p.category}/${y.p.category}`,
        ...names.blockers,
      ].join(", ");
      const [a, b] = x.p.id < y.p.id ? [x.p, y.p] : [y.p, x.p];
      pairs.push({
        a,
        b,
        distanceM: d,
        sameAddress: same,
        similarity: sim,
        verdict: explicit ? "explicit" : "disputed",
        reason,
      });
    }
  }
  return pairs;
}

/**
 * Группы явных дублей (связность по явным парам). Группа, где хоть одна пара мест спорная, не сливается целиком:
 * её явные пары остаются, но слияние — только если все места группы попарно явные (иначе группа в спорные).
 */
export function explicitGroups(pairs: readonly DuplicatePair[]): {
  groups: CheckPlace[][];
  split: CheckPlace[][];
} {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const r = find(p);
    parent.set(id, r);
    return r;
  };
  const byId = new Map<string, CheckPlace>();
  for (const pr of pairs) {
    if (pr.verdict !== "explicit") continue;
    byId.set(pr.a.id, pr.a);
    byId.set(pr.b.id, pr.b);
    parent.set(find(pr.a.id), find(pr.b.id));
  }
  const clusters = new Map<string, CheckPlace[]>();
  for (const [id, p] of byId) clusters.set(find(id), [...(clusters.get(find(id)) ?? []), p]);
  const explicitKey = new Set(
    pairs.filter((p) => p.verdict === "explicit").map((p) => `${p.a.id}|${p.b.id}`),
  );
  const groups: CheckPlace[][] = [];
  const split: CheckPlace[][] = [];
  for (const c of clusters.values()) {
    const ids = c.map((p) => p.id).sort();
    let complete = true;
    for (let i = 0; i < ids.length && complete; i++)
      for (let j = i + 1; j < ids.length; j++)
        if (!explicitKey.has(`${ids[i]}|${ids[j]}`)) {
          complete = false;
          break;
        }
    (complete ? groups : split).push(c);
  }
  return { groups, split };
}

/** Круг покрытия региона: пункт или зона поиска импорта. */
export type CoverageCircle = { code: string; at: LonLat; radiusM: number };

/** Категории, места которых законно лежат вдали от пунктов (вершины, урочища, маршруты): вне региона — только спорно. */
export const REMOTE_CATEGORIES: ReadonlySet<string> = new Set([
  "peaks",
  "nature",
  "sights",
  "excursions",
  "active",
]);

export type OutOfRegionOptions = {
  /** Вне круга дальше этого запаса, м — подозрение (по умолчанию 1000). */
  slackM?: number;
  /** Дальше этого от ближайшего круга, м — явно вне региона (по умолчанию 10 000). */
  explicitM?: number;
  /** Почтовые индексы региона (первые цифры). */
  postcodePrefixes?: readonly string[];
};

export type OutOfRegionFinding = {
  place: CheckPlace;
  /** Расстояние до края ближайшего круга, м (≤ 0 — внутри). */
  outsideM: number;
  nearest: string | null;
  verdict: "explicit" | "disputed";
  reason: string;
};

/** Чужая область в адресе: «Львівська область», «Закарпатська обл.» — кроме Івано-Франківської. */
const FOREIGN_OBLAST =
  /(вінницьк|волинськ|дніпропетровськ|донецьк|житомирськ|закарпатськ|запорізьк|київськ|кіровоградськ|луганськ|львівськ|миколаївськ|одеськ|полтавськ|рівненськ|сумськ|тернопільськ|харківськ|херсонськ|хмельницьк|черкаськ|чернівецьк|чернігівськ)\S*\s+обл/i;

/**
 * Места вне региона: точка дальше slackM от всех кругов пунктов/зон, чужой почтовый индекс или чужая область в
 * адресе. Явно (архив по --write) — только место с населённым пунктом (оно выдаёт себя за место пункта), точка
 * которого дальше explicitM от всех кругов; кроме REMOTE_CATEGORIES (вершины, природа, пам'ятки бывают далеко от
 * пунктов). Чужая область или индекс в адресе — только в отчёт (перевал Яблуниця граничит с Закарпаттям, адрес
 * Google ошибается). Место без пункта (точечный импорт для сценариев: скит, кафе по дороге) — только в отчёт; место
 * без точки «далеко» не бывает.
 */
export function findOutOfRegion(
  places: readonly CheckPlace[],
  circles: readonly CoverageCircle[],
  opts: OutOfRegionOptions = {},
): OutOfRegionFinding[] {
  const slack = opts.slackM ?? 1000;
  const explicitM = opts.explicitM ?? 10_000;
  const prefixes = opts.postcodePrefixes ?? [];
  const out: OutOfRegionFinding[] = [];
  for (const p of places) {
    const reasons: string[] = [];
    let outsideM = Number.NEGATIVE_INFINITY;
    let nearest: string | null = null;
    if (p.at && circles.length) {
      for (const c of circles) {
        const d = haversineMeters(p.at, c.at) - c.radiusM;
        if (nearest === null || d < outsideM) {
          outsideM = d;
          nearest = c.code;
        }
      }
      if (outsideM > slack) reasons.push(`точка за ${Math.round(outsideM)} м от круга ${nearest}`);
    }
    const postcodes = p.address?.match(/(?<!\d)\d{5}(?!\d)/g) ?? [];
    const foreignPost = prefixes.length
      ? postcodes.filter((c) => !prefixes.some((x) => c.startsWith(x)))
      : [];
    if (foreignPost.length) reasons.push(`чужой индекс ${foreignPost.join(", ")}`);
    const oblast = p.address ? FOREIGN_OBLAST.exec(p.address) : null;
    if (oblast) reasons.push(`чужая область в адресе («${oblast[0]}»)`);
    if (!reasons.length) continue;
    const outside = Number.isFinite(outsideM) && outsideM > slack;
    const explicit = Boolean(p.locality) && outside && outsideM > explicitM;
    const remote = REMOTE_CATEGORIES.has(p.category);
    out.push({
      place: p,
      outsideM: Number.isFinite(outsideM) ? outsideM : 0,
      nearest,
      verdict: explicit && !remote ? "explicit" : "disputed",
      reason:
        reasons.join("; ") +
        (explicit && remote ? " (категория вдали от пунктов — решает человек)" : "") +
        (outside && !p.locality ? " (место без пункта — точечный импорт?)" : ""),
    });
  }
  return out;
}
