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
  /** Дополнительно должно совпасть (Довбуш — только скелі/стежка/камінь, не музей). */
  also?: RegExp;
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
  // Раньше «huk»: в «Водоспад Женецький Гук» есть и слово «Гук», а срабатывает первый ориентир по порядку.
  {
    code: "zhenets",
    name: "Женецький водоспад",
    re: /женецьк\p{L}*\s+(водоспад|гук)|(водоспад|гук)\s+женец|zhenets\p{L}*\s+(waterfall|huk)|(waterfall|huk)\s+zhenets/iu,
    minutes: 150,
    kind: "walk",
    highMountain: false,
    winterOk: true,
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
    code: "dovbush-rocks",
    name: "Скелі / стежка Довбуша",
    re: /довбуш|dovbush/iu,
    also: /скел|стежк|камін|rock|trail|path/iu,
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
    code: "maniava-waterfall",
    name: "Манявський водоспад",
    re: /маняв\p{L}*\s+водоспад|водоспад\s+маняв|maniav\p{L}*\s+waterfall/iu,
    minutes: 120,
    kind: "walk",
    highMountain: false,
    winterOk: true,
  },
  {
    code: "maniava-skete",
    name: "Манявський скит",
    re: /маняв\p{L}*\s+(скит|монастир)|скит\s+маняв|maniav\p{L}*\s+(skete|monastery)/iu,
    minutes: 120,
    kind: "visit",
    highMountain: false,
    winterOk: true,
  },
];

/** Категории, где название — сам маршрут или место (не отель «Під Хом'яком» и не колиба «Говерла»). */
const LANDMARK_CATEGORIES: ReadonlySet<string> = new Set(["nature", "peaks", "sights"]);
/**
 * Не сам маршрут, а сервис или заведение с вершиной в названии: прокат, тур, джип/квадро, отель, музей, памятник,
 * кафе, такси («Джип-тур на Говерлу», «Музей Олекси Довбуша», «Пам'ятник Довбушу»).
 */
const NOT_ROUTE_RE =
  /(^|[^\p{L}])(прокат\p{L}*|тур|тури|турів|tour\p{L}*|джип\p{L}*|jeep\p{L}*|квадро\p{L}*|kvadro\p{L}*|quad\p{L}*|atv|баг+і|buggy|готел\p{L}*|hotel\p{L}*|пам.ятник\p{L}*|музе\p{L}*|museum|колиб\p{L}*|садиб\p{L}*|кафе|ресторан\p{L}*|таксі|taxi|трансфер\p{L}*)([^\p{L}]|$)/iu;

/** Турфирма/гид с вершиной в названии: экскурсия — весь маршрут + трансфер. */
const TOUR_CATEGORIES: ReadonlySet<string> = new Set(["excursions"]);
export const TOUR_TRANSFER_MIN = 120;

type NamedPlace = { category: string; names: readonly string[] };

/** «Вид на Говерлу», «Панорама Говерла и Петрос» — оглядовий майданчик, а не сам маршрут. */
const VIEW_RE = /(^|[^\p{L}])(вид|види|панорам\p{L}*|view|оглядов\p{L}*)([^\p{L}]|$)/iu;

/** Известный маршрут или место по названию (только в категориях природы, пам'яток, активностей, музеев). */
export function landmarkOf(p: NamedPlace): Landmark | null {
  if (!LANDMARK_CATEGORIES.has(p.category)) return null;
  if (p.names.some((n) => VIEW_RE.test(n) || NOT_ROUTE_RE.test(n))) return null;
  return LANDMARKS.find((l) => p.names.some((n) => l.re.test(n) && (!l.also || l.also.test(n)))) ?? null;
}

const L_ = "\\p{L}";
/**
 * Горное название (Google): гора, вершина, полонина, хребет, перевал, известные вершины Карпат, peak/summit/trail,
 * стежка, похід. «Горіховий» — не «гора» (границы слова).
 */
const MOUNTAIN_RE = new RegExp(
  `(^|[^${L_}])(гор[аиуі]|вершин${L_}*|полонин${L_}*|хреб${L_}*|перевал${L_}*|говерл${L_}*|хом['’ʼ]?як${L_}*|` +
    `петрос${L_}*|піп\\s+іван${L_}*|чорногор${L_}*|пікуй${L_}*|синяк${L_}*|близниц${L_}*|peak|summit|mountain|mount|` +
    `ridge|trail|hiking|стежк${L_}*|похід${L_}*)([^${L_}]|$)`,
  "iu",
);
/** Погода: горные места по категории (активности в горах — джип/квадро-туры, прокаты — тоже). */
const WEATHER_MOUNTAIN_CATEGORIES: ReadonlySet<string> = new Set([
  "nature",
  "active",
  "excursions",
  "sights",
]);
/** Сезон: общая «горная» регулярка — только для маршрутов природы и активностей (не «Церква на горі»). */
const SEASON_ROUTE_CATEGORIES: ReadonlySet<string> = new Set(["nature", "active"]);

/** Раздел «Вершини»: место в нём — всегда сходження (погода и сезон), даже без горного слова в названии. */
const PEAKS = "peaks";

type MountainPlace = NamedPlace & { extraCategories?: readonly string[] | undefined };
const catsOf = (p: MountainPlace) => [p.category, ...(p.extraCategories ?? [])];
/** Известный маршрут на вершину или экскурсия на вершину (турфирма с вершиной в названии). */
const summitRoute = (p: MountainPlace) => landmarkOf(p)?.kind === "hike" || tourLandmarkOf(p) !== null;

/**
 * Горное место для ПОГОДЫ (в грозу, сильный ветер, снегопад, гололёд не предлагаем и предупреждаем): маршрут или
 * экскурсия на вершину; место раздела «Вершини»; природа/пам'ятки с горным названием без стоп-слов маршрута (готель, музей, кафе…); активности
 * и экскурсии в горах с горным названием — всегда, даже джип-/квадро-тур и прокат («Джип-тур на Говерлу», «Тур на
 * полонину»: в грозу на полонину не едут). «Вид на…» (оглядовий майданчик) — не горное.
 */
export function isMountainHike(p: MountainPlace): boolean {
  if (summitRoute(p)) return true;
  const cats = catsOf(p);
  if (cats.includes(PEAKS)) return true;
  if (!cats.some((c) => WEATHER_MOUNTAIN_CATEGORIES.has(c))) return false;
  if (p.names.some((n) => VIEW_RE.test(n))) return false;
  const activity = cats.includes("active") || cats.includes("excursions");
  if (!activity && p.names.some((n) => NOT_ROUTE_RE.test(n))) return false;
  return p.names.some((n) => MOUNTAIN_RE.test(n));
}

/**
 * Горный поход для СЕЗОНА (зимой не предлагаем): маршрут или экскурсия на вершину, либо природа/активность с горным
 * названием без стоп-слов маршрута — джип-тур, прокат и «Церква на горі» зимой видны. Только основная категория:
 * импорт добавляет active всем подъёмникам, курортам и прокатам (mapping.ts), а «Витяг на гору» — не поход.
 */
export function isSeasonalHike(p: MountainPlace): boolean {
  if (summitRoute(p) || p.category === PEAKS) return true;
  if (!SEASON_ROUTE_CATEGORIES.has(p.category)) return false;
  if (p.names.some((n) => NOT_ROUTE_RE.test(n) || VIEW_RE.test(n))) return false;
  return p.names.some((n) => MOUNTAIN_RE.test(n));
}

/**
 * Маршрут экскурсии по названию турфирмы/гида («на Говерлу, Петрос, Піп Іван, Хом'як»): самый короткий из названных —
 * турист выбирает вершину с гидом, а день должен вместить хотя бы её.
 */
export function tourLandmarkOf(p: NamedPlace): Landmark | null {
  if (!TOUR_CATEGORIES.has(p.category)) return null;
  const all = LANDMARKS.filter((l) => l.kind === "hike" && p.names.some((n) => l.re.test(n)));
  return all.sort((a, b) => a.minutes - b.minutes)[0] ?? null;
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

/** Вершина без известного маршрута, хв: одно значение для «Мій план» и плана ассистента. */
export const PEAK_NO_ROUTE_MIN = 240;

/** По категории (код подкатегории): типичное время на месте, хв. */
export const CATEGORY_MINUTES: Readonly<Record<string, number>> = {
  sights: 40,
  nature: 75,
  // Вершина без известного маршрута (LANDMARKS) — сходження на пів дня (и в плане ассистента).
  peaks: PEAK_NO_ROUTE_MIN,
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
  bars: 90,
  chany: 120,
  spa: 150,
  markets: 45,
  souvenirs: 30,
  stores: 30,
};

const KIND_OF_CATEGORY: Readonly<Record<string, VisitKind>> = {
  sights: "visit",
  nature: "walk",
  peaks: "hike",
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
  // Бар — вечірній відпочинок, а не обід (не закриває «де поїсти»).
  bars: "relax",
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
