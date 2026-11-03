// Проверка сценария от модели программой — без неё в БД ничего не пишется. Каждый пункт — место из списка кандидатов
// (опубликованное место каталога); длительность — реалистичная (маршрут на вершину — фиксированно, иначе в пределах
// оценки по месту); время сдвигается вперёд на дорогу между пунктами; день — не дольше разумного, место открыто в
// это время, сезон и аудитория (діти, без авто, дощ) соблюдены, дублей нет.
import type { LocalizedText, ScenarioSeason } from "../db/index.js";
import {
  isMountainHike,
  placeFitsSeason,
  SCENARIO_SEASONS,
  SCENARIO_TAGS,
  sphericalMeters,
  travelMinutes,
  type ScenarioTag,
} from "../modules/planner/index.js";
import type { Brief } from "./briefs.js";
import {
  INDOOR_CATEGORIES,
  MEAL_CATEGORIES,
  RELAX_CATEGORIES,
  seasonsOf,
  weeklyShort,
  type CandidateSet,
} from "./candidates.js";

const RELAX_SET: ReadonlySet<string> = new Set(RELAX_CATEGORIES);
import type { GenPlace } from "./catalog.js";
import type { GenScenario } from "./prompt.js";

export const DAY_START = "07:00";
export const DAY_END = "23:00";
/** Сумма времени на местах за день, хв (13 год: день экскурсии на вершину с вечерей и чаном — 07:00–21:00). */
export const DAY_ACTIVE_MAX_MIN = 13 * 60;
/** «Большой» пункт (поход, экскурсия, лыжи) — от 4 год; такой один на день. */
export const BIG_MIN = 240;
/** Большой поход начинается не позже, хв от полуночи (10:00). */
export const BIG_START_MAX = 10 * 60;
/** Без авто — между соседними пунктами не дальше, м по прямой. */
export const FOOT_HOP_MAX_M = 2_500;
/** На авто — не дальше, м по прямой. */
export const CAR_HOP_MAX_M = 35_000;
/** Место открыто в это время — хотя бы в столько дней недели (график известен). */
export const OPEN_DAYS_MIN = 1;
/**
 * Захід сонця для 48,4° пн. ш. (Яремче) — консервативно, на кінець сезону, з запасом на сутінки в горах, хв:
 * зима ~16:15, весна ~18:30 (березень), літо ~20:15 (серпень), осінь ~16:45 (листопад).
 */
export const SUNSET_MIN: Readonly<Record<ScenarioSeason, number>> = {
  winter: 16 * 60 + 15,
  spring: 18 * 60 + 30,
  summer: 20 * 60 + 15,
  autumn: 16 * 60 + 45,
};
/** Похід має закінчитися не пізніше ніж за стільки хв до заходу. */
export const HIKE_SUNSET_MARGIN = 30;
/** Обід: якщо день триває через 12:00–15:00 — їжа має початися в цьому вікні. */
export const LUNCH_WINDOW = { from: 11 * 60 + 30, to: 15 * 60 + 30 } as const;
/** З дітьми — не більше однієї великої активності (від 150 хв) на день. */
export const KIDS_BIG_MIN = 150;
/** Гірські дороги: до відстані по прямій ×1,45 (серпантини), 35 км/год, +5 хв на паркування. */
export const ROAD_FACTOR = 1.45;
export const CAR_KMH = 35;
/** «Зигзаг»: шлях дня довший за 2,5× розмах точок + 4 км. */
const ZIGZAG = { factor: 2.5, slackM: 4_000 } as const;
/** Надворі (до заходу сонця й із запасним варіантом на дощ): походи, прогулянки, природа, пам'ятки, активності. */
const OUTDOOR_KINDS = new Set(["hike", "walk"]);
const OUTDOOR_CATEGORIES = new Set(["nature", "sights", "active", "ski-resorts", "ski-lifts", "markets"]);
export const isOutdoor = (p: GenPlace) =>
  OUTDOOR_KINDS.has(p.estimate.kind) || OUTDOOR_CATEGORIES.has(p.category);
const isIndoor = (p: GenPlace) =>
  (INDOOR_CATEGORIES as readonly string[]).includes(p.category) || p.tags.includes("rainy-day");
export const ITEMS_PER_DAY = { min: 2, max: 8 } as const;
export const ALTERNATIVES_MAX = 3;

export type DraftItem = {
  dayNo: number;
  placeId: string;
  /** Для отчёта и проверки глазами (в БД не пишется). */
  placeName: string;
  category: string;
  timeHint: string;
  durationMin: number;
  note: LocalizedText | null;
  alternatives: string[];
};

export type ScenarioDraft = {
  code: string;
  title: LocalizedText;
  description: LocalizedText | null;
  days: number;
  tags: ScenarioTag[];
  seasons: ScenarioSeason[];
  items: DraftItem[];
  /** По дням: активное время, начало и конец (для отчёта). */
  dayStats: { dayNo: number; activeMin: number; start: string; end: string }[];
};

export type ValidationResult = { draft: ScenarioDraft | null; errors: string[]; fixes: string[] };

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const toMin = (t: string): number | null => {
  const m = HHMM.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const fromMin = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const round5 = (m: number) => Math.round(m / 5) * 5;
const ceil5 = (m: number) => Math.ceil(m / 5) * 5;

/** Реалистичная длительность: маршрут — фиксированно; иначе ответ модели в пределах ×0,5…×2 оценки места. */
export function realisticMinutes(p: GenPlace, asked: number): number {
  const est = p.estimate.minutes;
  if (p.estimate.fixed) return est;
  const lo = Math.max(15, round5(est * 0.5));
  const hi = round5(est * 2);
  return Math.min(hi, Math.max(lo, round5(Number.isFinite(asked) ? asked : est)));
}

/** Дорога между пунктами, хв: пешком при близости или без авто, иначе на авто гірськими дорогами (+5 хв паркування). */
export function hopMinutes(
  from: GenPlace,
  to: GenPlace,
  noCar: boolean,
): { meters: number; minutes: number } {
  const meters = sphericalMeters(from.location, to.location);
  if (noCar || meters <= 1200) return { meters, minutes: meters < 50 ? 0 : travelMinutes(meters, "walk") };
  return { meters, minutes: Math.max(1, Math.round(((meters * ROAD_FACTOR) / 1000 / CAR_KMH) * 60)) + 5 };
}

/** Открыто ли место в [from, to) (минуты дня) хотя бы в OPEN_DAYS_MIN дней недели; график неизвестен — да. */
export function openEnough(p: GenPlace, from: number, to: number): boolean {
  if (!p.weekly.length) return true;
  let days = 0;
  for (let d = 1; d <= 7; d++) {
    const ok = p.weekly.some((w) => {
      if (w.dayOfWeek !== d) return false;
      const o = toMin(w.opensAt) ?? 0;
      let c = toMin(w.closesAt) ?? 0;
      if (c <= o) c += 24 * 60; // через полночь (или круглосуточно 00:00–00:00)
      return from >= o && to <= c;
    });
    if (ok) days++;
  }
  return days >= OPEN_DAYS_MIN;
}

/** Теги, которые модель может добавить сама. */
export const MODEL_TAGS = SCENARIO_TAGS.filter(
  (t) => !["one_day", "multi_day", "kids", "no_car", "rain", "ski", "excursion"].includes(t),
);

/**
 * Приписка программы «Графік: …» в примечании (снимается перед повторной проверкой): только дни и часы в формате
 * weeklyShort, в любом месте примечания — совет до и после неё сохраняется, а программа не задвоит график.
 */
const SCHEDULE_RE = /\s*Графік:\s*(?:(?:пн|вт|ср|чт|пт|сб|нд|вихідний)(?!\p{L})|\d[\d:]*|[\s,;–-])+\.?\s*/gu;
export const stripSchedule = (note: string) =>
  note.replace(SCHEDULE_RE, (m) => (/\d{2}:\d{2}/.test(m) ? " " : m)).trim();

/**
 * Длина примечания к пункту (символов, без приписки «Графік: …»). Модели и критику называем NOTE_ASK_MAX; NOTE_MAX —
 * предел программы с запасом: модель считает символы приблизительно, а вторая платная попытка (весь сценарий) ради
 * лишней фразы не окупается. БД (jsonb) и экран «Мій план» длину не ограничивают, DTO админки — 2000.
 */
export const NOTE_ASK_MAX = 400;
export const NOTE_MAX = 480;

/** Точка после сокращения — не конец предложения («у м. Яремче», «макс. 20 км»). Единицы («40 хв.») — конец: их середину закрывает проверка строчной буквы. */
const ABBREVIATION_END =
  /(?:^|[^\p{L}\d])(?:\p{L}|вул|пл|просп|пров|буд|обл|смт|ім|оз|св|ст|напр|див|бл|прибл|макс|тел|ін)$/iu;
/** Номер пункта в начале предложения («1. Йти»), а не число в конце («до 18:00.»). */
const NUMBERING_END = /(?:^|[.!?…]["»”“')]*\s)\d+$/u;
const SENTENCE_END = /[.!?…]+["»”“')]*(?=\s|$)/gu;
const ENDS_SENTENCE = /[.!?…]["»”“')]*$/u;
/** Хвост-заготовка: за ним должно было идти продолжение («Правило розвороту:»). */
const DANGLING = /[:;,–—-]$/u;

/**
 * Примечание без обрыва: длинное — до последнего законченного предложения в пределах max; хвост без конца предложения
 * («… тихо. Вра», «… Правило розвороту:») снимается и при допустимой длине. Если законченного предложения нет, а текст
 * длинный или висит на двоеточии — пустая строка (лучше без совета, чем оборванный). Готовый результат не меняется
 * при повторном вызове. Короткий фрагмент без точки («Прогулянка») остаётся как есть.
 */
export function trimNote(raw: string, max: number = NOTE_MAX): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length <= max && (s === "" || ENDS_SENTENCE.test(s))) return s;
  let end = 0;
  for (const m of s.matchAll(SENTENCE_END)) {
    const stop = m.index + m[0].length;
    if (stop > max) break;
    const next = s[stop + 1];
    if (next && /\p{Ll}/u.test(next)) continue;
    const before = s.slice(0, m.index);
    if (m[0].startsWith(".") && (ABBREVIATION_END.test(before) || NUMBERING_END.test(before))) continue;
    end = stop;
  }
  if (end) return s.slice(0, end);
  return s.length <= max && !DANGLING.test(s) ? s : "";
}

/**
 * Назва: модели называем TITLE_ASK_MAX. Предел программы 79, а не 80: прежняя проверка резала ровно на 80, и такая длина
 * в старом журнале означает обрезанную назву. Не режем: назва видна туристу первой, длиннее — ошибка и повторная попытка.
 * DTO допускает 200, БД длину не ограничивает.
 */
export const TITLE_ASK_MAX = 60;
export const TITLE_MAX = 79;
/** Описание: модели — DESCRIPTION_ASK_MAX, программа режет по предложению на DESCRIPTION_MAX (DTO — 2000). */
export const DESCRIPTION_ASK_MAX = 250;
export const DESCRIPTION_MAX = 400;

const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();

/** Что не так с названием; null — можно показывать. */
function titleProblem(raw: string, label: string): string | null {
  const t = squeeze(raw);
  if (t.length > TITLE_MAX)
    return `${label} довша за ${TITLE_MAX} символів (${t.length}) — скороти до ${TITLE_ASK_MAX}`;
  if (DANGLING.test(t)) return `${label} обірвана: «${t}»`;
  return null;
}

/** Текст с оборванным концом или длиннее предела (то, что trimNote изменил бы). */
const isTorn = (raw: string, max: number) => trimNote(raw, max) !== squeeze(raw);

/** Примечание из готового черновика: совет целый, приписка «Графік: …» дописана до конца. */
function noteTorn(raw: string): boolean {
  const all = squeeze(raw);
  const advice = squeeze(stripSchedule(all));
  return isTorn(advice, NOTE_MAX) || (advice !== all && !ENDS_SENTENCE.test(all));
}

const BAD_TEXT = /https?:|www\.|[<>`*#]|\+?\d[\d\s-]{8,}/i;

export function validateScenario(b: Brief, set: CandidateSet, gen: GenScenario): ValidationResult {
  const errors: string[] = [];
  const fixes: string[] = [];
  const seasons = seasonsOf(b);
  const days = [...gen.days].sort((x, y) => x.day - y.day);
  if (days.length !== b.days || days.some((d, i) => d.day !== i + 1))
    errors.push(`днів має бути рівно ${b.days} (1…${b.days}), отримано: ${days.map((d) => d.day).join(",")}`);
  const used = new Set<string>();
  const items: DraftItem[] = [];
  const dayStats: ScenarioDraft["dayStats"] = [];
  let anyAdultsOnly = false;
  const placesById = new Map([...set.byRef.values()].map((p) => [p.id, p]));
  const sunset = Math.min(...seasons.map((x) => SUNSET_MIN[x]));

  for (const d of days) {
    const list = d.items;
    if (list.length < ITEMS_PER_DAY.min || list.length > ITEMS_PER_DAY.max)
      errors.push(
        `день ${d.day}: пунктів має бути ${ITEMS_PER_DAY.min}–${ITEMS_PER_DAY.max}, а не ${list.length}`,
      );
    let prev = null as { place: GenPlace; end: number } | null;
    let active = 0;
    let big = 0;
    let meal = false;
    let start: number | null = null;
    let end = 0;
    let lunch = false;
    let kidsBig = 0;
    let outdoor = false;
    let rainAlt = false;
    const points: GenPlace[] = [];
    for (const it of list) {
      const place = set.byRef.get(it.ref.trim());
      if (!place) {
        errors.push(`день ${d.day}: «${it.ref}» — немає в списку кандидатів`);
        continue;
      }
      if (used.has(place.id)) errors.push(`${it.ref} (${place.name}) повторюється`);
      used.add(place.id);
      const minutes = realisticMinutes(place, it.minutes);
      if (Math.abs(minutes - it.minutes) >= 15)
        fixes.push(`${it.ref} ${place.name}: тривалість ${it.minutes} → ${minutes} хв`);
      const asked = toMin(it.time);
      if (asked === null) errors.push(`${it.ref}: час «${it.time}» не ГГ:ХХ`);
      let at: number = asked ?? prev?.end ?? toMin(DAY_START)!;
      if (prev) {
        const hop = hopMinutes(prev.place, place, Boolean(b.theme.noCar));
        if (b.theme.noCar && hop.meters > FOOT_HOP_MAX_M)
          errors.push(
            `${it.ref}: без авто — ${(hop.meters / 1000).toFixed(1)} км від попереднього (макс. 2,5 км)`,
          );
        if (!b.theme.noCar && hop.meters > CAR_HOP_MAX_M)
          errors.push(
            `${it.ref}: ${(hop.meters / 1000).toFixed(0)} км від попереднього — задалеко для одного дня`,
          );
        const earliest = ceil5(prev.end + hop.minutes);
        if (at < earliest) {
          fixes.push(
            `${it.ref} ${place.name}: старт ${fromMin(at)} → ${fromMin(earliest)} (дорога ${hop.minutes} хв)`,
          );
          at = earliest;
        }
      }
      if (at < toMin(DAY_START)!) errors.push(`${it.ref}: старт ${fromMin(at)} — раніше ${DAY_START}`);
      const finish: number = at + minutes;
      if (finish > toMin(DAY_END)!)
        errors.push(`день ${d.day}: ${place.name} закінчується о ${fromMin(finish)} — пізніше ${DAY_END}`);
      if (!openEnough(place, at, finish))
        errors.push(
          `${it.ref} (${place.name}): за графіком зачинено ${fromMin(at)}–${fromMin(Math.min(finish, 1439))}`,
        );
      for (const s of seasons)
        if (!placeFitsSeason(place, s)) errors.push(`${it.ref} (${place.name}) не підходить для сезону ${s}`);
      const isBig = minutes >= BIG_MIN && ["hike", "tour", "ski"].includes(place.estimate.kind);
      if (isBig) {
        big++;
        if (place.estimate.kind === "hike" && at > BIG_START_MAX)
          errors.push(
            `${it.ref} (${place.name}): похід ${minutes} хв має починатися до 10:00, а не о ${fromMin(at)}`,
          );
      }
      const isMeal = (MEAL_CATEGORIES as readonly string[]).includes(place.category);
      if (isMeal) meal = true;
      if (isMeal && at >= LUNCH_WINDOW.from && at <= LUNCH_WINDOW.to) lunch = true;
      points.push(place);
      if (isOutdoor(place)) {
        outdoor = true;
        const limit = place.estimate.kind === "hike" ? sunset - HIKE_SUNSET_MARGIN : sunset;
        if (finish > limit)
          errors.push(
            `${it.ref} (${place.name}): надворі до ${fromMin(finish)} — після заходу сонця (${fromMin(sunset)}` +
              `${place.estimate.kind === "hike" ? ", для походу — з запасом 30 хв" : ""})`,
          );
      }
      if (!isMeal && !RELAX_SET.has(place.category) && minutes >= KIDS_BIG_MIN) kidsBig++;
      if (
        b.theme.rain &&
        !(INDOOR_CATEGORIES as readonly string[]).includes(place.category) &&
        !place.tags.includes("rainy-day")
      )
        errors.push(`${it.ref} (${place.name}): у дощ — лише під дахом`);
      anyAdultsOnly ||= place.adultsOnly;
      if (b.theme.kids && place.adultsOnly) errors.push(`${it.ref} (${place.name}): не для дітей`);
      active += minutes;
      start ??= at;
      end = finish;
      const alternatives: string[] = [];
      for (const a of it.alternatives ?? []) {
        const alt = set.byRef.get(a.trim());
        if (!alt || alt.id === place.id || alternatives.includes(alt.id)) {
          fixes.push(`${it.ref}: альтернатива «${a}» прибрана`);
          continue;
        }
        if (alternatives.length < ALTERNATIVES_MAX) {
          alternatives.push(alt.id);
          if (isIndoor(alt)) rainAlt = true;
        }
      }
      // Графік дописує программа — прежний (из раунда критика) снимаем и пишем заново один раз.
      const askedNote = stripSchedule(it.note_uk ?? "").replace(/\s+/g, " ");
      let note = trimNote(askedNote);
      if (note !== askedNote)
        fixes.push(
          note
            ? `${it.ref} ${place.name}: примітку скорочено до закінченого речення (${askedNote.length} → ${note.length} символів)`
            : `${it.ref} ${place.name}: примітку прибрано — немає закінченого речення (${askedNote.length} символів)`,
        );
      // Працює не щодня (ринок у Косові — лише в суботу) — графік у примітку, щоб турист обрав день. Лимит — только на
      // совет выше: приписка не режется и не вытесняет его предложения.
      const openDays = new Set(place.weekly.map((w) => w.dayOfWeek)).size;
      if (openDays > 0 && openDays < 7) note = `${note} Графік: ${weeklyShort(place.weekly)}.`.trim();
      if (note && BAD_TEXT.test(note)) errors.push(`${it.ref}: у примітці посилання, телефон або розмітка`);
      items.push({
        dayNo: d.day,
        placeId: place.id,
        placeName: place.name,
        category: place.category,
        timeHint: fromMin(at),
        durationMin: minutes,
        note: note ? { uk: note } : null,
        alternatives,
      });
      prev = { place, end: finish };
    }
    if (active > DAY_ACTIVE_MAX_MIN)
      errors.push(
        `день ${d.day}: ${Math.round(active / 6) / 10} год на місцях — більше ${DAY_ACTIVE_MAX_MIN / 60} год`,
      );
    if (big > 1)
      errors.push(`день ${d.day}: ${big} великі пункти (похід/екскурсія/лижі) — має бути не більше одного`);
    if (list.length >= 3 && !meal) errors.push(`день ${d.day}: немає де поїсти`);
    // День большого похода/экскурсии — обед на маршруте (с собой), окно обеда не требуется.
    if (start !== null && start <= 12 * 60 && end >= 15 * 60 && !lunch && big === 0)
      errors.push(`день ${d.day}: немає обіду між 11:30 і 15:30`);
    if (b.theme.kids && kidsBig > 1)
      errors.push(`день ${d.day}: з дітьми — не більше однієї великої активності (від ${KIDS_BIG_MIN} хв)`);
    if (!b.theme.rain && outdoor && !rainAlt)
      errors.push(
        `день ${d.day}: немає запасного варіанту на дощ (альтернатива під дахом хоча б для одного пункту)`,
      );
    if (points.length >= 3) {
      let path = 0;
      let spread = 0;
      for (let k = 1; k < points.length; k++)
        path += sphericalMeters(points[k - 1]!.location, points[k]!.location);
      for (const a of points)
        for (const c of points) spread = Math.max(spread, sphericalMeters(a.location, c.location));
      if (path > ZIGZAG.factor * spread + ZIGZAG.slackM)
        errors.push(
          `день ${d.day}: маршрут зигзагом (${(path / 1000).toFixed(0)} км шляху при розмаху ` +
            `${(spread / 1000).toFixed(0)} км) — впорядкуй за географією`,
        );
    }
    dayStats.push({ dayNo: d.day, activeMin: active, start: fromMin(start ?? 0), end: fromMin(end) });
  }

  if (b.target && !used.has(b.target.placeId)) errors.push(`немає обовʼязкового пункту «${b.target.name}»`);

  const title = squeeze(gen.title_uk);
  const askedTitleEn = squeeze(gen.title_en);
  // Английская назва необязательна: плохая не стоит платной повторной попытки или потери правки критика.
  const titleEnProblem = titleProblem(askedTitleEn, "англійська назва");
  const titleEn = titleEnProblem ? "" : askedTitleEn;
  if (titleEnProblem) fixes.push(`${titleEnProblem}; прибрано`);
  const askedDescription = squeeze(gen.description_uk);
  const description = trimNote(askedDescription, DESCRIPTION_MAX);
  if (description !== askedDescription)
    fixes.push(
      description
        ? `опис скорочено до закінченого речення (${askedDescription.length} → ${description.length} символів)`
        : `опис прибрано — немає закінченого речення (${askedDescription.length} символів)`,
    );
  if (title.length < 3) errors.push("назва порожня");
  const titleUkProblem = titleProblem(title, "назва");
  if (titleUkProblem) errors.push(titleUkProblem);
  if (BAD_TEXT.test(title) || BAD_TEXT.test(description))
    errors.push("у назві чи описі посилання або розмітка");
  // Аудитория и формат (діти, без авто, дощ, лижі, дні) — только из заказа; модель добавляет лишь описательные теги.
  const tags = new Set<ScenarioTag>(b.theme.tags);
  for (const t of gen.tags) if ((MODEL_TAGS as readonly string[]).includes(t)) tags.add(t as ScenarioTag);
  tags.delete(b.days === 1 ? "multi_day" : "one_day");
  tags.add(b.days === 1 ? "one_day" : "multi_day");
  if (!b.theme.noCar) tags.delete("no_car");
  if (!b.theme.rain) tags.delete("rain");
  if (b.seasons.length !== 1 || b.seasons[0] !== "winter") tags.delete("ski");
  if (anyAdultsOnly) tags.delete("kids");
  // Описательные теги — только если в плане есть такое (у скиту без водоспаду — без «Водоспади»).
  const picked = items.map((i) => placesById.get(i.placeId)!);
  if (!picked.some((x) => x.kind === "waterfall")) tags.delete("waterfalls");
  if (
    !picked.some(
      (x) => x.estimate.kind === "hike" || (x.estimate.kind === "walk" && x.estimate.minutes >= 120),
    )
  )
    tags.delete("hiking");
  if (!picked.some((x) => isMountainHike(x) || ["ski-resorts", "ski-lifts"].includes(x.category)))
    tags.delete("mountains");

  // То же место под разными карточками Google: тот же маршрут или та же точка (до 150 м) той же категории.
  const seen = new Map<string, string>();
  for (const it of items) {
    const p = placesById.get(it.placeId)!;
    const lm = p.estimate.landmark?.code;
    if (lm) {
      if (seen.has(lm)) errors.push(`${p.name}: той самий маршрут, що й ${seen.get(lm)}`);
      seen.set(lm, p.name);
    }
  }
  const nonMeal = items.filter((i) => !(MEAL_CATEGORIES as readonly string[]).includes(i.category));
  for (let i = 0; i < nonMeal.length; i++)
    for (let j = i + 1; j < nonMeal.length; j++) {
      const a = placesById.get(nonMeal[i]!.placeId)!;
      const c = placesById.get(nonMeal[j]!.placeId)!;
      if (a.category === c.category && sphericalMeters(a.location, c.location) < 150)
        errors.push(`${a.name} і ${c.name} — те саме місце (до 150 м), залиш одне`);
    }

  if (errors.length) return { draft: null, errors, fixes };
  return {
    draft: {
      code: b.code,
      title: { uk: title, ...(titleEn ? { en: titleEn } : {}) },
      description: description ? { uk: description } : null,
      days: b.days,
      tags: SCENARIO_TAGS.filter((t) => tags.has(t)),
      seasons: [...b.seasons],
      items,
      dayStats,
    },
    errors,
    fixes,
  };
}

const CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Как is_localized_text в БД (0002): объект «код языка → строка», uk — непустая строка. */
export function isLocalizedText(v: unknown): v is LocalizedText {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.uk !== "string" || o.uk.trim() === "") return false;
  return Object.entries(o).every(([k, t]) => /^[a-z]{2,3}(-[A-Z]{2})?$/.test(k) && typeof t === "string");
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Проверка готового сценария (--from-file: файл могли поправить руками): форма как у API и CHECK БД (код, название и
 * описание — localized, теги и сезоны из справочников, дни 1…5 и номер дня каждого пункта, время, длительность 5–1440),
 * места — опубликованные места каталога без повторов, длительность — реалистичная для места, место и альтернативы
 * подходят сезонам. Любая форма входа (не объект, не массив) — ошибки, а не исключение. Пустой список — можно писать.
 */
export function checkDraft(raw: unknown, places: ReadonlyMap<string, GenPlace>): string[] {
  if (!isObj(raw)) return ["сценарій — не обʼєкт"];
  const d = raw as Partial<Record<keyof ScenarioDraft, unknown>>;
  const e: string[] = [];
  if (typeof d.code !== "string" || !CODE_RE.test(d.code)) e.push(`код «${String(d.code)}» не латиницею`);
  if (!isLocalizedText(d.title) || squeeze(d.title.uk).length < 3) e.push("назва — не localized з uk");
  else
    for (const [lang, t] of Object.entries(d.title)) {
      const problem = titleProblem(t ?? "", `назва (${lang})`);
      if (problem) e.push(problem);
    }
  if (d.description !== null && d.description !== undefined) {
    if (!isLocalizedText(d.description)) e.push("опис — не localized з uk");
    else
      for (const [lang, t] of Object.entries(d.description))
        if (isTorn(t ?? "", DESCRIPTION_MAX)) e.push(`опис (${lang}) обірваний або задовгий: «${t}»`);
  }
  const days =
    Number.isInteger(d.days) && (d.days as number) >= 1 && (d.days as number) <= 5 ? (d.days as number) : 0;
  if (!days) e.push(`днів ${String(d.days)} — має бути 1…5`);
  if (!Array.isArray(d.tags) || d.tags.some((t) => !(SCENARIO_TAGS as readonly unknown[]).includes(t)))
    e.push(`невідомі теги: ${String(d.tags)}`);
  const seasons =
    Array.isArray(d.seasons) && d.seasons.every((x) => (SCENARIO_SEASONS as readonly unknown[]).includes(x))
      ? (d.seasons as ScenarioSeason[])
      : null;
  if (!seasons) e.push(`невідомі сезони: ${String(d.seasons)}`);
  if (!Array.isArray(d.items) || d.items.length === 0 || d.items.length > 40)
    return [...e, "пунктів має бути 1…40"];
  const fits = (p: GenPlace) =>
    (seasons?.length ? seasons : SCENARIO_SEASONS).filter((x) => !placeFitsSeason(p, x));
  const seenDays = new Set<number>();
  const used = new Set<string>();
  for (const [k, it] of d.items.entries()) {
    if (!isObj(it)) {
      e.push(`пункт ${k + 1} — не обʼєкт`);
      continue;
    }
    const at = `день ${String(it.dayNo)}, ${typeof it.placeName === "string" ? it.placeName : String(it.placeId)}`;
    if (!Number.isInteger(it.dayNo) || (it.dayNo as number) < 1 || (it.dayNo as number) > days)
      e.push(`${at}: день поза 1…${days}`);
    else seenDays.add(it.dayNo as number);
    if (typeof it.timeHint !== "string" || toMin(it.timeHint) === null)
      e.push(`${at}: час «${String(it.timeHint)}» не ГГ:ХХ`);
    const minutes = it.durationMin;
    const minutesOk = Number.isInteger(minutes) && (minutes as number) >= 5 && (minutes as number) <= 1440;
    if (!minutesOk) e.push(`${at}: тривалість ${String(minutes)} поза 5…1440`);
    if (it.note !== null && it.note !== undefined && !isLocalizedText(it.note))
      e.push(`${at}: примітка — не localized`);
    else if (isLocalizedText(it.note))
      for (const [lang, t] of Object.entries(it.note))
        if (noteTorn(t ?? "")) e.push(`${at}: примітка (${lang}) обірвана або задовга: «${t}»`);
    const alts = it.alternatives;
    if (
      !Array.isArray(alts) ||
      alts.length > ALTERNATIVES_MAX ||
      alts.some((a) => typeof a !== "string" || !UUID_RE.test(a))
    ) {
      e.push(`${at}: альтернативи — до ${ALTERNATIVES_MAX} uuid`);
    } else
      for (const a of alts as string[]) {
        const alt = places.get(a.toLowerCase());
        if (!alt) e.push(`${at}: альтернативи ${a} немає серед опублікованих`);
        else if (fits(alt).length)
          e.push(`${at}: альтернатива ${alt.name} не для сезону ${fits(alt).join(",")}`);
      }
    if (typeof it.placeId !== "string" || !UUID_RE.test(it.placeId)) {
      e.push(`${at}: placeId не uuid`);
      continue;
    }
    const id = it.placeId.toLowerCase();
    if (used.has(id)) e.push(`${at}: місце повторюється`);
    used.add(id);
    const p = places.get(id);
    if (!p) {
      e.push(`${at}: місця немає серед опублікованих у каталозі`);
      continue;
    }
    if (minutesOk && realisticMinutes(p, minutes as number) !== minutes)
      e.push(`${at}: тривалість ${String(minutes)} хв нереальна (оцінка ${p.estimate.minutes} хв)`);
    if (seasons) for (const x of fits(p)) e.push(`${at}: не підходить для сезону ${x}`);
  }
  for (let n = 1; n <= days; n++) if (!seenDays.has(n)) e.push(`день ${n} без пунктів`);
  return e;
}

/** Готовый сценарий обратно в формат ответа модели (ссылки p1…pN) — для критика. */
export function draftToGen(d: ScenarioDraft, set: CandidateSet): GenScenario {
  const refOf = new Map(set.candidates.map((c) => [c.place.id, c.ref]));
  return {
    title_uk: d.title.uk,
    title_en: d.title.en ?? "",
    description_uk: d.description?.uk ?? "",
    tags: d.tags.filter((t) => (MODEL_TAGS as readonly string[]).includes(t)),
    days: Array.from({ length: d.days }, (_, k) => ({
      day: k + 1,
      items: d.items
        .filter((i) => i.dayNo === k + 1)
        .map((i) => ({
          ref: refOf.get(i.placeId) ?? i.placeId,
          time: i.timeHint,
          minutes: i.durationMin,
          note_uk: stripSchedule(i.note?.uk ?? ""),
          alternatives: i.alternatives.map((a) => refOf.get(a) ?? a),
        })),
    })),
  };
}

/** Расчёты программы для критика: по дням — время, длительность, дорога от предыдущего, закат. */
export function draftFacts(b: Brief, set: CandidateSet, d: ScenarioDraft): string[] {
  const byId = new Map(set.candidates.map((c) => [c.place.id, c]));
  const sunset = Math.min(...seasonsOf(b).map((x) => SUNSET_MIN[x]));
  const out = [`захід сонця (консервативно для сезону): ~${fromMin(sunset)}`];
  for (let day = 1; day <= d.days; day++) {
    let prev: GenPlace | null = null;
    for (const i of d.items.filter((x) => x.dayNo === day)) {
      const c = byId.get(i.placeId);
      if (!c) continue;
      const hop = prev ? hopMinutes(prev, c.place, Boolean(b.theme.noCar)) : null;
      const end = (toMin(i.timeHint) ?? 0) + i.durationMin;
      const road = hop
        ? `; дорога від попереднього ~${hop.minutes} хв, ${(hop.meters / 1000).toFixed(1)} км по прямій`
        : "";
      out.push(
        `день ${day}: ${i.timeHint}–${fromMin(end)} ${c.ref} ${c.place.name} (${i.durationMin} хв${road})`,
      );
      prev = c.place;
    }
  }
  return out;
}
