// Реалистичная длительность пункта плана (просьба владельца 03.11.2026: «у похода на Хом'як 1:30 — неверно, это
// ~6–7 год»). Раньше длительность бралась только по категории (природа — 90 хв), и вершина получала столько же,
// сколько оглядовий майданчик. Теперь: известные маршруты и места Карпат — по названию из Google (время туда и
// обратно от обычной точки старта, без дороги до неё), активности — по названию (джип-тур, квадроцикли, коні), иначе —
// по категории. Без Nest и БД; используется планировщиком, генератором сценариев и может использоваться ассистентом.

/** Что это за пункт для расписания дня. */
export type VisitKind =
  | "hike"
  | "walk"
  | "visit"
  | "tour"
  | "activity"
  | "meal"
  | "relax"
  | "ski"
  | "shopping";

export type Landmark = {
  code: string;
  /** Подпись для отчётов и промпта (uk). */
  name: string;
  /** Совпадение по любому языковому варианту названия места. */
  re: RegExp;
  /** Время на маршруте/месте, хв (туда и обратно от точки старта). */
  minutes: number;
  kind: VisitKind;
  /** Высокогорный поход: зимой — только как явно зимний маршрут с гидом. */
  highMountain: boolean;
  /** Уместно зимой без особой пометки. */
  winterOk: boolean;
  /** Откуда считается время (для примечания). */
  from?: string;
};

const A = "['’ʼ`]?"; // апостроф в названиях Google пишут по-разному или пропускают

/**
 * Известные маршруты и места Прикарпатья. Время — типичное для туриста средней подготовки (туда и обратно, с
 * привалами): Говерла от Заросляка 6–8 год, Хом'як от Татарова/Поляниці 6–7 год и т. д.
 */
export const LANDMARKS: readonly Landmark[] = [
  {
    code: "hoverla",
    name: "Говерла",
    re: new RegExp(`говерл|hoverla|goverla`, "iu"),
    minutes: 420,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Заросляка",
  },
  {
    code: "petros",
    name: "Петрос",
    re: /петрос|petros/iu,
    minutes: 450,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Кваси або Заросляка",
  },
  {
    code: "pip-ivan",
    name: "Піп Іван",
    re: /піп\s*іван|pip\s*ivan/iu,
    minutes: 600,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Дземброні",
  },
  {
    code: "khomiak",
    name: "Хом'як",
    re: new RegExp(`хом${A}як|khom${A}?iak|khomyak`, "iu"),
    minutes: 390,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Татарова або Поляниці",
  },
  {
    code: "synyak",
    name: "Синяк",
    re: /синяк|synyak|syniak/iu,
    minutes: 330,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Поляниці",
  },
  {
    code: "pikui",
    name: "Пікуй",
    re: /пікуй|pikui|pikuy/iu,
    minutes: 330,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Біласовиці або Сихлеса",
  },
  {
    code: "blyznytsi",
    name: "Близниці",
    re: /близниц|blyznyts/iu,
    minutes: 330,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Драгобрату",
  },
  {
    code: "shpytsi",
    name: "Шпиці",
    re: /шпиц|shpyts/iu,
    minutes: 540,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Заросляка",
  },
  {
    code: "yavirnyk",
    name: "Явірник",
    re: /явірник|yavirnyk/iu,
    minutes: 300,
    kind: "hike",
    highMountain: true,
    winterOk: false,
    from: "від Яремче",
  },
  {
    code: "makovytsia",
    name: "Маковиця",
    re: /маковиц|makovyts/iu,
    minutes: 210,
    kind: "hike",
    highMountain: false,
    winterOk: false,
    from: "від центру Яремче",
  },
  {
    code: "huk",
    name: "Гук (гора / водоспад)",
    re: /(^|[^\p{L}])гук([^\p{L}]|$)|(^|[^\p{L}])huk([^\p{L}]|$)/iu,
    minutes: 150,
    kind: "walk",
    highMountain: false,
    winterOk: true,
  },
  {
    code: "zhenets",
    name: "Женецький водоспад",
    re: /женецьк\p{L}*\s+(водоспад|гук)|водоспад\s+женец|zhenets\p{L}*\s+waterfall/iu,
    minutes: 150,
    kind: "walk",
    highMountain: false,
    winterOk: true,
  },
  {
    code: "dovbush-rocks",
    name: "Скелі / стежка Довбуша",
    re: /довбуш|dovbush/iu,
    minutes: 150,
    kind: "walk",
    highMountain: false,
    winterOk: true,
  },
  {
    code: "probii",
    name: "Водоспад Пробій",
    re: /пробій|probii|probiy/iu,
    minutes: 45,
    kind: "walk",
    highMountain: false,
    winterOk: true,
  },
  {
    code: "maniava",
    name: "Манявський скит",
    re: /маняв|maniav/iu,
    minutes: 120,
    kind: "visit",
    highMountain: false,
    winterOk: true,
  },
];

/** Категории, где название — сам маршрут или место (не отель «Під Хом'яком» и не колиба «Говерла»). */
const LANDMARK_CATEGORIES: ReadonlySet<string> = new Set(["nature", "sights", "active", "museums"]);

/** Турфирма/гид с вершиной в названии: экскурсия — весь маршрут + трансфер. */
const TOUR_CATEGORIES: ReadonlySet<string> = new Set(["excursions"]);
export const TOUR_TRANSFER_MIN = 120;

type NamedPlace = { category: string; names: readonly string[] };

/** «Вид на Говерлу», «Панорама Говерла и Петрос» — оглядовий майданчик, а не сам маршрут. */
const VIEW_RE = /(^|[^\p{L}])(вид|види|панорам\p{L}*|view|оглядов\p{L}*)([^\p{L}]|$)/iu;

/** Известный маршрут или место по названию (только в категориях природы, пам'яток, активностей, музеев). */
export function landmarkOf(p: NamedPlace): Landmark | null {
  if (!LANDMARK_CATEGORIES.has(p.category)) return null;
  if (p.names.some((n) => VIEW_RE.test(n))) return null;
  return LANDMARKS.find((l) => p.names.some((n) => l.re.test(n))) ?? null;
}

/** Самый длинный из маршрутов, названных в названии турфирмы/гида (экскурсия на Говерлу, Петрос, Хом'як…). */
export function tourLandmarkOf(p: NamedPlace): Landmark | null {
  if (!TOUR_CATEGORIES.has(p.category)) return null;
  const all = LANDMARKS.filter((l) => l.kind === "hike" && p.names.some((n) => l.re.test(n)));
  return all.sort((a, b) => b.minutes - a.minutes)[0] ?? null;
}

const L = "\\p{L}";
const word = (src: string) => new RegExp(`(^|[^${L}])(${src})([^${L}]|$)`, "iu");

/** Активности по названию из Google (минуты на месте). */
const ACTIVITY_BY_NAME: readonly { re: RegExp; minutes: number }[] = [
  { re: /джип|jeep|позашлях/iu, minutes: 240 },
  { re: /рафтинг|rafting|сплав/iu, minutes: 180 },
  { re: /квадро|kvadro|quad|atv|багі|баггі|buggy|мото\s*тур|moto/iu, minutes: 150 },
  { re: /кінн\p{L}*|коні|конюш|horse/iu, minutes: 120 },
  { re: /хаскі|husky/iu, minutes: 90 },
  { re: /риболов|форел|fishery|fishing/iu, minutes: 120 },
  { re: /rope\s*jump|роуп/iu, minutes: 60 },
  { re: /zip-?line|зіп|зип|тарзанк|roller\s*coaster/iu, minutes: 45 },
  { re: word("гойдалк\\p{L}*|качел\\p{L}*|swing"), minutes: 20 },
  { re: word("альтанк\\p{L}*|бесідк\\p{L}*|пікнік\\p{L}*"), minutes: 60 },
  { re: word("озеро|lake"), minutes: 90 },
  { re: /оглядов|viewpoint|краєвид/iu, minutes: 30 },
];

/** По категории (код подкатегории): типичное время на месте, хв. */
export const CATEGORY_MINUTES: Readonly<Record<string, number>> = {
  sights: 40,
  nature: 75,
  museums: 60,
  excursions: 240,
  active: 120,
  entertainment: 90,
  kids: 90,
  "adult-fun": 120,
  "ski-resorts": 300,
  "ski-lifts": 240,
  "ski-schools": 120,
  "ski-rental": 30,
  "ski-shops": 30,
  "gear-rental": 30,
  restaurants: 75,
  kolyby: 75,
  cafes: 45,
  "fast-food": 30,
  chany: 120,
  spa: 150,
  markets: 45,
  souvenirs: 30,
  stores: 30,
};

const KIND_OF_CATEGORY: Readonly<Record<string, VisitKind>> = {
  sights: "visit",
  nature: "walk",
  museums: "visit",
  excursions: "tour",
  active: "activity",
  entertainment: "activity",
  kids: "activity",
  "adult-fun": "activity",
  "ski-resorts": "ski",
  "ski-lifts": "ski",
  "ski-schools": "ski",
  "ski-rental": "ski",
  "ski-shops": "shopping",
  "gear-rental": "activity",
  restaurants: "meal",
  kolyby: "meal",
  cafes: "meal",
  "fast-food": "meal",
  chany: "relax",
  spa: "relax",
  markets: "shopping",
  souvenirs: "shopping",
  stores: "shopping",
};

export type VisitEstimate = {
  minutes: number;
  kind: VisitKind;
  /** Совпавший известный маршрут/место (или вершина в названии турфирмы). */
  landmark: Landmark | null;
  /** Длительность задана маршрутом (не оценка по категории) — генератор её не уменьшает. */
  fixed: boolean;
};

/** Сколько времени занимает пункт: известный маршрут → по названию активности → по категории (иначе 60 хв). */
export function visitEstimate(p: NamedPlace): VisitEstimate {
  const lm = landmarkOf(p);
  if (lm) return { minutes: lm.minutes, kind: lm.kind, landmark: lm, fixed: true };
  const tour = tourLandmarkOf(p);
  if (tour) return { minutes: tour.minutes + TOUR_TRANSFER_MIN, kind: "tour", landmark: tour, fixed: true };
  const kind = KIND_OF_CATEGORY[p.category] ?? "visit";
  if (p.category === "active" || p.category === "sights" || p.category === "nature") {
    const a = ACTIVITY_BY_NAME.find((x) => p.names.some((n) => x.re.test(n)));
    if (a) return { minutes: a.minutes, kind, landmark: null, fixed: false };
  }
  return { minutes: CATEGORY_MINUTES[p.category] ?? 60, kind, landmark: null, fixed: false };
}

export const visitMinutes = (p: NamedPlace): number => visitEstimate(p).minutes;
