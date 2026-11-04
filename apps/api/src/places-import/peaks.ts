// Раздел «Вершини» (просьба владельца 04.11.2026): вершины для однодневного похода из пилотного региона (Яремче, Микуличин,
// Татарів, Поляниця/Буковель, Яблуниця, Ворохта) — Чорногора, Ґорґани, Свидовець и лёгкие горы у Яремче/Буковеля.
// Данные — только из проверяемых источников (поле sources, ссылка на версию статьи): высота и хребет — Вікіпедія/Wikidata,
// маршрут — раздел «Туристичні стежки» статьи (время «↑ / ↓») или описание маршрута. Чего в источнике нет, то null:
// сложность без данных маршрута не выводится («немає даних»). Набор высоты «difference» — разница высот вершины и
// старта (обе — из источников), «stated» — перепад, указанный в источнике. Повтор — CLI peaks:sync (README apps/api).
// Модуль без зависимостей: его читают api (выдача мест категории peaks) и CLI.

export type PeakText = { uk: string; en: string };
export type PeakPoint = { lon: number; lat: number };

/** Шкала как у лыжных трасс: цвет + форма значка + текст (не только цвет). */
export const PEAK_DIFFICULTIES = ["easy", "moderate", "hard", "expert"] as const;
export type PeakDifficulty = (typeof PEAK_DIFFICULTIES)[number];

export const PEAK_RANGES = ["chornohora", "gorgany", "svydovets"] as const;
export type PeakRange = (typeof PEAK_RANGES)[number];

export type PeakSource = { title: string; url: string };

export type PeakRoute = {
  /** Точка старта (село, база, парковка) — как в источнике. */
  start: PeakText;
  /** Координаты старта (Wikidata); null — в источниках нет (маршрут в Картах — до вершины). */
  startLocation: PeakPoint | null;
  /** Высота старта, м (источник), — для набора «difference». */
  startElevationM: number | null;
  /** Длина в один бок, км (источник); туда-назад — ×2 (тем же путём). */
  oneWayKm: number | null;
  /** Набор высоты, м: difference — вершина − старт; stated — перепад из источника. */
  elevationGainM: number | null;
  gainKind: "difference" | "stated" | null;
  /** Время подъёма и спуска, ч (источник). */
  upHours: number | null;
  downHours: number | null;
  /** Маркировка/путь — как в источнике. */
  trail: PeakText | null;
};

export type PeakData = {
  slug: string;
  name: PeakText;
  /** id места Google на staging (найдено или добавлено peaks:sync); null — места ещё нет. */
  googlePlaceId: string | null;
  heightM: number | null;
  range: PeakRange | null;
  /** Вершина (Wikidata P625). */
  location: PeakPoint;
  wikidata: string | null;
  route: PeakRoute | null;
  /** Коротко о вершине/доступе, если в источнике есть (без маршрута — что известно). */
  note: PeakText | null;
  /** Сезонность/предупреждения — только из источников. */
  warnings: PeakText[];
  sources: PeakSource[];
  /** Файл Wikimedia Commons для обложки (Wikidata P18 или фото статьи). */
  commonsFile: string | null;
  /** Название для поиска места в Google (только для мест, которых ещё нет): имя результата должно совпасть с match. */
  search?: { query: string; match: RegExp };
};

/**
 * Правило сложности. По каждой известной мере маршрута — уровень (первая строка, куда мера помещается), итог —
 * наибольший из уровней: набор < maxGainM, туда-назад < maxKm, время туда-назад ≤ maxHours. Нужна длина или время
 * маршрута (набор сам по себе не маршрут) — иначе null («немає даних»). Сверх «Складна» — «Дуже складна».
 */
export const PEAK_DIFFICULTY_RULE: readonly {
  level: Exclude<PeakDifficulty, "expert">;
  maxGainM: number;
  maxKm: number;
  maxHours: number;
}[] = [
  { level: "easy", maxGainM: 500, maxKm: 10, maxHours: 4 },
  { level: "moderate", maxGainM: 900, maxKm: 16, maxHours: 7 },
  { level: "hard", maxGainM: 1300, maxKm: 22, maxHours: 10 },
];

/** Туда-назад тем же путём, км; нет длины — null. */
export const roundTripKm = (r: PeakRoute | null): number | null =>
  r?.oneWayKm == null ? null : Math.round(r.oneWayKm * 2 * 10) / 10;

/** Время туда-назад, ч: только если в источнике есть и подъём, и спуск. */
export const totalHours = (r: PeakRoute | null): number | null =>
  r?.upHours == null || r.downHours == null ? null : r.upHours + r.downHours;

export function peakDifficulty(r: PeakRoute | null): PeakDifficulty | null {
  const km = roundTripKm(r);
  const hours = totalHours(r);
  if (km === null && hours === null) return null;
  const rank = (fits: (row: (typeof PEAK_DIFFICULTY_RULE)[number]) => boolean): number => {
    const i = PEAK_DIFFICULTY_RULE.findIndex(fits);
    return i === -1 ? PEAK_DIFFICULTY_RULE.length : i;
  };
  const gain = r?.elevationGainM ?? null;
  const levels = [
    gain === null ? 0 : rank((x) => gain < x.maxGainM),
    km === null ? 0 : rank((x) => km < x.maxKm),
    hours === null ? 0 : rank((x) => hours <= x.maxHours),
  ];
  return PEAK_DIFFICULTIES[Math.max(...levels)]!;
}

const wiki = (title: string, oldid: number, lang = "uk"): PeakSource => ({
  title: `Вікіпедія (${lang}): ${title}`,
  url: `https://${lang}.wikipedia.org/w/index.php?oldid=${oldid}`,
});
const wd = (id: string): PeakSource => ({
  title: `Wikidata ${id}`,
  url: `https://www.wikidata.org/wiki/${id}`,
});

// Старты (Wikidata/Вікіпедія).
const ZAROSLYAK = {
  start: { uk: "База «Заросляк» (дорога з Ворохти)", en: "Zarosliak base (road from Vorokhta)" },
  startLocation: { lon: 24.5375, lat: 48.164167 },
  startElevationM: 1330,
};
const ZAROSLYAK_SOURCE = wiki("Заросляк", 47487164);
const WINTER_GUIDE: PeakText = {
  uk: "Взимку високогір'я Чорногори лавинонебезпечне — сходження лише з гідом і зимовим спорядженням.",
  en: "In winter the Chornohora highlands are avalanche-prone — go only with a guide and winter gear.",
};

/** Вершины раздела: порядок — по хребтам; выдача сортируется в Mini App. */
export const PEAKS: readonly PeakData[] = [
  {
    slug: "hoverla",
    name: { uk: "Говерла", en: "Hoverla" },
    googlePlaceId: "ChIJJ6a4ZTn9NkcRVa_k0Ycfo_c",
    heightM: 2061,
    range: "chornohora",
    location: { lon: 24.5, lat: 48.160278 },
    wikidata: "Q627508",
    route: {
      ...ZAROSLYAK,
      oneWayKm: null,
      elevationGainM: 731,
      gainKind: "difference",
      upHours: 3,
      downHours: 2,
      trail: { uk: "Синій маркер від бази «Заросляк»", en: "Blue trail from Zarosliak" },
    },
    note: {
      uk: "Найвища вершина України. Від «Заросляка» є й пологіший зелений маркер через полонину Козьмеска (↑ ~3 год).",
      en: "Ukraine's highest peak. A gentler green trail from Zarosliak goes via Kozmeska meadow (up ~3 h).",
    },
    warnings: [
      {
        uk: "Взимку сходження на Говерлу має альпіністську категорію 1Б — лише з гідом і спорядженням.",
        en: "In winter the ascent is graded 1B (mountaineering) — only with a guide and gear.",
      },
      {
        uk: "Влітку в грозу на відкритих схилах б'є блискавка — були загиблі; виходьте зранку.",
        en: "Summer thunderstorms bring lightning on open slopes — there were fatalities; start early.",
      },
    ],
    sources: [wiki("Говерла", 49045976), ZAROSLYAK_SOURCE, wd("Q627508")],
    commonsFile: "Говерла 2015.JPG",
  },
  {
    slug: "petros",
    name: { uk: "Петрос", en: "Petros" },
    googlePlaceId: "ChIJM3KZwuoCN0cRhRP2BGdnJdg",
    heightM: 2020,
    range: "chornohora",
    location: { lon: 24.421111, lat: 48.172778 },
    wikidata: "Q1419635",
    route: {
      start: { uk: "Ясіня, залізнична станція Свидовець", en: "Yasinia, Svydovets railway station" },
      startLocation: { lon: 24.374722, lat: 48.272778 },
      startElevationM: null,
      oneWayKm: null,
      elevationGainM: null,
      gainKind: null,
      upHours: 5,
      downHours: 4,
      trail: {
        uk: "Зелений маркер до пол. Шиса, далі синій через г. Петросул",
        en: "Green trail to Shysa meadow, then blue via Petrosul",
      },
    },
    note: null,
    warnings: [
      {
        uk: "Взимку на схилах Петроса часто сходять снігові лавини.",
        en: "Avalanches are frequent on Petros slopes in winter.",
      },
    ],
    sources: [wiki("Петрос (Чорногора)", 47655210), wd("Q1419635"), wd("Q1093421")],
    commonsFile: "Petros 2.jpg",
  },
  {
    slug: "brebeneskul",
    name: { uk: "Бребенескул", en: "Brebeneskul" },
    googlePlaceId: "ChIJa7LT1LX7NkcRReTVG29GdDk",
    heightM: 2038,
    range: "chornohora",
    location: { lon: 24.58, lat: 48.0975 },
    wikidata: "Q2091106",
    route: {
      ...ZAROSLYAK,
      oneWayKm: null,
      elevationGainM: 708,
      gainKind: "difference",
      upHours: 5.5,
      downHours: 4.5,
      trail: {
        uk: "Жовтий маркер до оз. Несамовите, далі червоний через г. Ребра",
        en: "Yellow trail to Nesamovyte lake, then red via Rebra",
      },
    },
    note: null,
    warnings: [WINTER_GUIDE],
    sources: [wiki("Бребенескул (гора)", 44352697), ZAROSLYAK_SOURCE, wd("Q2091106")],
    commonsFile: "Brebeneskul szczyt.jpg",
  },
  {
    slug: "pip-ivan",
    name: { uk: "Піп Іван Чорногірський", en: "Pip Ivan (Chornohora)" },
    googlePlaceId: "ChIJ3bvXbUP3NkcRCb7jE4FLeJA",
    heightM: 2028,
    range: "chornohora",
    location: { lon: 24.627222, lat: 48.046944 },
    wikidata: "Q2003560",
    route: {
      start: { uk: "Село Шибене (Верховинщина)", en: "Shybene village (Verkhovyna area)" },
      startLocation: null,
      startElevationM: null,
      oneWayKm: null,
      elevationGainM: null,
      gainKind: null,
      upHours: 5,
      downHours: 4,
      trail: {
        uk: "Зелений маркер через ур. Погорілець, пол. Веснарка й оз. Марічейка",
        en: "Green trail via Pohorilets, Vesnarka meadow and Marycheika lake",
      },
    },
    note: {
      uk: "На вершині — колишня обсерваторія «Білий Слон». Старт далеко від Яремче (Верховинщина).",
      en: "The former 'White Elephant' observatory is on the summit. The start is far from Yaremche.",
    },
    warnings: [WINTER_GUIDE],
    sources: [wiki("Піп Іван (Чорногора)", 49045958), wd("Q2003560")],
    commonsFile: "Pop Iwan.jpg",
  },
  {
    slug: "turkul",
    name: { uk: "Туркул", en: "Turkul" },
    googlePlaceId: "ChIJjdUAto38NkcRemXGiK3b2ak",
    heightM: 1933,
    range: "chornohora",
    location: { lon: 24.531111, lat: 48.123889 },
    wikidata: "Q4466192",
    route: {
      ...ZAROSLYAK,
      oneWayKm: null,
      elevationGainM: 603,
      gainKind: "difference",
      upHours: 4.5,
      downHours: 3.5,
      trail: {
        uk: "Жовтий маркер до оз. Несамовите, далі червоний",
        en: "Yellow trail to Nesamovyte lake, then red",
      },
    },
    note: null,
    warnings: [WINTER_GUIDE],
    sources: [wiki("Туркул", 36780936), ZAROSLYAK_SOURCE, wd("Q4466192")],
    commonsFile: "Turkul.jpg",
    search: { query: "гора Туркул Чорногора", match: /туркул/i },
  },
  {
    slug: "rebra",
    name: { uk: "Ребра", en: "Rebra" },
    googlePlaceId: "ChIJBwg4qJD7NkcR5VE9nQQkJqE",
    heightM: 2001,
    range: "chornohora",
    location: { lon: 24.56, lat: 48.111389 },
    wikidata: "Q683191",
    route: {
      ...ZAROSLYAK,
      oneWayKm: null,
      elevationGainM: 671,
      gainKind: "difference",
      upHours: 4,
      downHours: 3,
      trail: {
        uk: "Жовтий маркер до оз. Несамовите, далі червоний",
        en: "Yellow trail to Nesamovyte lake, then red",
      },
    },
    note: null,
    warnings: [WINTER_GUIDE],
    sources: [wiki("Ребра (гора)", 48946251), ZAROSLYAK_SOURCE, wd("Q683191")],
    commonsFile: "Rebra ukr.jpg",
    search: { query: "гора Ребра Чорногора", match: /ребр/i },
  },
  {
    slug: "shpytsi",
    name: { uk: "Шпиці", en: "Shpytsi" },
    googlePlaceId: "ChIJk4no2XD7NkcR_FtU8pRsmqI",
    heightM: 1863,
    range: "chornohora",
    location: { lon: 24.568056, lat: 48.125556 },
    wikidata: "Q24423",
    route: null,
    note: {
      uk: "Скельні виступи 20–50 м на східних схилах. Повз Шпиці йде зелений маркер із с. Бистрець.",
      en: "Rock walls 20–50 m high on the eastern slopes. The green trail from Bystrets passes Shpytsi.",
    },
    warnings: [WINTER_GUIDE],
    sources: [wiki("Шпиці", 44352670), wiki("Бребенескул (гора)", 44352697), wd("Q24423")],
    commonsFile: "Шпиці 2.jpg",
  },
  {
    slug: "hutyn-tomnatyk",
    name: { uk: "Гутин Томнатик", en: "Hutyn Tomnatyk" },
    googlePlaceId: "ChIJO4szgOr7NkcRCHlVQes25R8",
    heightM: 2016,
    range: "chornohora",
    location: { lon: 24.556667, lat: 48.1 },
    wikidata: "Q4152998",
    route: null,
    note: {
      uk: "Відріг головного хребта: стежкою від г. Бребенескул ~1 год (маршрути з сіл у джерелі не описані).",
      en: "A spur of the main ridge: ~1 h by path from Brebeneskul (no village routes in the source).",
    },
    warnings: [WINTER_GUIDE],
    sources: [wiki("Гутин Томнатик", 47441661), wd("Q4152998")],
    commonsFile: "Gutin Tomnatyk.jpg",
    search: { query: "гора Гутин Томнатик", match: /томнатик/i },
  },
  {
    slug: "pozhyzhevska",
    name: { uk: "Пожижевська", en: "Pozhyzhevska" },
    googlePlaceId: "ChIJ8SJJuO78NkcRm-Enr44p7EE",
    heightM: 1822,
    range: "chornohora",
    location: { lon: 24.523611, lat: 48.144167 },
    wikidata: "Q4368734",
    route: null,
    note: {
      uk: "На головному хребті між Брескулом і Данцером: від кожної з них ~1 год червоним маркером.",
      en: "On the main ridge between Breskul and Dantser: ~1 h from either along the red trail.",
    },
    warnings: [WINTER_GUIDE],
    sources: [wiki("Пожижевська", 48972105), wd("Q4368734")],
    commonsFile: "Pozyzewska Breskul.jpg",
    search: { query: "гора Пожижевська", match: /пожиж/i },
  },
  {
    slug: "dantser",
    name: { uk: "Данцер (Данциж)", en: "Dantser (Dantsyzh)" },
    googlePlaceId: "ChIJH-Acn478NkcRz6csA0XyLgk",
    heightM: 1850,
    range: "chornohora",
    location: { lon: 24.531111, lat: 48.135 },
    wikidata: "Q4154911",
    route: null,
    note: {
      uk: "На головному хребті між Пожижевською і Туркулом: від кожної ~1 год червоним маркером.",
      en: "On the main ridge between Pozhyzhevska and Turkul: ~1 h from either along the red trail.",
    },
    warnings: [WINTER_GUIDE],
    sources: [wiki("Данцер", 36780753), wd("Q4154911")],
    commonsFile: "Dancerz Pozyzewska Howerla pol.jpg",
    search: { query: "гора Данциж Чорногора", match: /данц/i },
  },
  {
    slug: "kukul",
    name: { uk: "Кукул", en: "Kukul" },
    googlePlaceId: "ChIJqS6JCFriNkcRT52focn4uNU",
    heightM: 1539,
    range: "chornohora",
    location: { lon: 24.545278, lat: 48.215556 },
    wikidata: "Q16703989",
    route: {
      start: { uk: "КПП «Чорногора» (Завоєла)", en: "Chornohora checkpoint (Zavoiela)" },
      startLocation: null,
      startElevationM: null,
      oneWayKm: 7,
      elevationGainM: 580,
      gainKind: "stated",
      upHours: null,
      downHours: null,
      trail: null,
    },
    note: {
      uk: "Інші марковані маршрути: з Ворохти через г. Осередок (12 км, перепад 800 м), з Вороненки (13 км, 720 м).",
      en: "Other marked routes: from Vorokhta via Oseredok (12 km, 800 m), from Voronenka (13 km, 720 m).",
    },
    warnings: [],
    sources: [wiki("Кукул", 47811096), wiki("Kukul", 78665124, "pl"), wd("Q16703989")],
    commonsFile: "Біля г.Кукул.jpg",
    search: { query: "гора Кукул", match: /кукул|kukul/i },
  },
  {
    slug: "khomiak",
    name: { uk: "Хом'як", en: "Khomiak" },
    googlePlaceId: "ChIJVWwwbx8iN0cRRkJAV-Fom6A",
    heightM: 1542,
    range: "gorgany",
    location: { lon: 24.499361, lat: 48.367806 },
    wikidata: "Q4499702",
    route: {
      start: { uk: "Село Татарів", en: "Tatariv village" },
      startLocation: { lon: 24.577778, lat: 48.343611 },
      startElevationM: 750,
      oneWayKm: 6,
      elevationGainM: 792,
      gainKind: "difference",
      upHours: 2.5,
      downHours: null,
      trail: null,
    },
    note: {
      uk: "Підйом також із Поляниці та Яблуниці (3–4 год). Біля вершини — кам'яні розсипи.",
      en: "Also reachable from Polianytsia and Yablunytsia (3–4 h up). Scree near the top.",
    },
    warnings: [
      {
        uk: "Під вершиною — лавинонебезпечна ділянка (таблички на полонині); навесні 2010 р. тут загинув турист.",
        en: "Below the summit is an avalanche zone (signs on the meadow); a hiker died here in spring 2010.",
      },
    ],
    sources: [
      wiki("Хом'як (гора)", 45968630),
      {
        title: "Karpatium: Гора Хом'як (маршрут з Татарова)",
        url: "https://karpatium.com.ua/hirski-masyvy/hora-khomiak",
      },
      wiki("Татарів", 48428150),
      wd("Q4499702"),
    ],
    commonsFile: "Homyak.JPG",
  },
  {
    slug: "syniak",
    name: { uk: "Синяк", en: "Syniak" },
    googlePlaceId: "ChIJvbY-nVciN0cRIV3I26qP4Us",
    heightM: 1665,
    range: "gorgany",
    location: { lon: 24.4579, lat: 48.3888 },
    wikidata: "Q4420615",
    route: null,
    note: {
      uk: "Біля сіл Поляниця й Татарів. До ~1300 м ліс, вище — луки й суцільні кам'яні розсипи.",
      en: "Near Polianytsia and Tatariv. Forest up to ~1300 m, then meadows and continuous scree.",
    },
    warnings: [],
    sources: [wiki("Синяк (гора)", 46775434), wd("Q4420615")],
    commonsFile: "Гора Синяк.jpg",
  },
  {
    slug: "dovbushanka",
    name: { uk: "Довбушанка", en: "Dovbushanka" },
    googlePlaceId: "ChIJQ10DAuU8N0cRL9VBa3uyWX8",
    heightM: 1754,
    range: "gorgany",
    location: { lon: 24.374669, lat: 48.424908 },
    wikidata: "Q4163961",
    route: null,
    note: {
      uk: "Схили в кам'яних осипищах і важкопрохідному криволіссі.",
      en: "Slopes of scree and dense dwarf pine.",
    },
    warnings: [],
    sources: [wiki("Довбушанка (гора)", 47886535), wd("Q4163961")],
    commonsFile: "Горы 408.jpg",
    search: { query: "гора Довбушанка", match: /довбуш/i },
  },
  {
    slug: "yavirnyk-horhan",
    name: { uk: "Явірник-Горган", en: "Yavirnyk-Horhan" },
    googlePlaceId: "ChIJEWXfiL4jN0cRSo8xw7O7Cls",
    heightM: 1467,
    range: "gorgany",
    location: { lon: 24.497778, lat: 48.4075 },
    wikidata: "Q20096214",
    route: null,
    note: {
      uk: "Перепад висоти від долини Пруту — 600–700 м; туристи часто зупиняються на сусідньому Горгані Явірницькому.",
      en: "600–700 m above the Prut valley; hikers often stop at neighbouring Horhan Yavirnytskyi.",
    },
    warnings: [],
    sources: [wiki("Явірник-Горган", 46009928), wd("Q20096214")],
    commonsFile: "Вид на гори з Явірник-Горгану.jpg",
    search: { query: "гора Явірник Горган", match: /явірник/i },
  },
  {
    slug: "makovytsia",
    name: { uk: "Маковиця", en: "Makovytsia" },
    googlePlaceId: "ChIJe2j91YYmN0cRQCipXuCcenU",
    heightM: 984.5,
    range: "gorgany",
    location: { lon: 24.591083, lat: 48.451333 },
    wikidata: "Q195179",
    route: {
      start: { uk: "Яремче (передмістя Ямна, вул. Івана Франка)", en: "Yaremche (Yamna, Ivana Franka St)" },
      startLocation: { lon: 24.556389, lat: 48.453611 },
      startElevationM: 525,
      oneWayKm: 3.5,
      elevationGainM: 460,
      gainKind: "difference",
      upHours: null,
      downHours: null,
      trail: {
        uk: "По хребту від каплички біля джерела",
        en: "Along the ridge from the chapel by the spring",
      },
    },
    note: {
      uk: "Другий маршрут — від Каменю Довбуша стежкою Довбуша. Вказівник на вершині: до Яремче 3,5 км.",
      en: "Second route — from Dovbush Stone along Dovbush trail. Summit sign: 3.5 km to Yaremche.",
    },
    warnings: [],
    sources: [wiki("Маковиця (Яремче)", 42425340), wd("Q195179"), wd("Q146524")],
    commonsFile: "Makovytsa.jpg",
  },
  {
    slug: "bukovel",
    name: { uk: "Гора Буковель", en: "Bukovel mountain" },
    googlePlaceId: "ChIJf0nyKWEYN0cRIWPXyx6Z8hU",
    heightM: null,
    range: null,
    location: { lon: 24.4107, lat: 48.3486 },
    wikidata: null,
    route: null,
    note: {
      uk: "Над курортом Буковель (Поляниця, ~920 м). Найвища точка курорту — г. Довга, 1372 м.",
      en: "Above Bukovel resort (Polianytsia, ~920 m). The resort's highest point is Dovha, 1372 m.",
    },
    warnings: [],
    sources: [wiki("Буковель", 48950788)],
    commonsFile: null,
  },
  {
    slug: "blyznytsia",
    name: { uk: "Близниця", en: "Blyznytsia" },
    googlePlaceId: "ChIJmVSvQV4FN0cRY4Za_VrorzA",
    heightM: 1883,
    range: "svydovets",
    location: { lon: 24.232778, lat: 48.2225 },
    wikidata: "Q4088161",
    route: null,
    note: {
      uk: "Найвища вершина Свидовця, над курортом Драгобрат. Через неї йде маршрут «Вершинами Свидовця» (Ясіня — Усть-Чорна).",
      en: "Svydovets' highest peak, above Drahobrat resort, on the 'Svydovets Peaks' route (Yasinia — Ust-Chorna).",
    },
    warnings: [],
    sources: [wiki("Близниця", 44714758), wd("Q4088161")],
    commonsFile: "Svydovec, Blyznycja, jih.jpg",
  },
  {
    slug: "drahobrat",
    name: { uk: "Драгобрат (гора)", en: "Drahobrat (peak)" },
    googlePlaceId: "ChIJdcri1PYPN0cRjHiI3YI4gtE",
    heightM: 1763,
    range: "svydovets",
    location: { lon: 24.231806, lat: 48.232333 },
    wikidata: "Q81828",
    route: null,
    note: {
      uk: "Вершина над курортом Драгобрат (1300–1700 м); за 1 км на південь — Близниця, за 2 км на північ — Стіг.",
      en: "Peak above Drahobrat resort (1300–1700 m); Blyznytsia 1 km south, Stih 2 km north.",
    },
    warnings: [],
    sources: [wiki("Драгобрат (гора)", 43141112), wiki("Драгобрат (курорт)", 48969784), wd("Q81828")],
    commonsFile: "Svydovec, Drahobrat, Gorgany.jpg",
    search: { query: "гора Драгобрат вершина", match: /драгобрат|жандарм/i },
  },
  {
    slug: "stih",
    name: { uk: "Стіг", en: "Stih" },
    googlePlaceId: "ChIJYdDgwTwQN0cRRnUoKRLoRYQ",
    heightM: 1704,
    range: "svydovets",
    location: { lon: 24.22293, lat: 48.25052 },
    wikidata: "Q4442697",
    route: null,
    note: {
      uk: "Північно-східний Свидовець, на маршруті «Вершинами Свидовця»; на півдні сідловина до Близниці.",
      en: "North-eastern Svydovets on the 'Svydovets Peaks' route; a saddle leads south to Blyznytsia.",
    },
    warnings: [],
    sources: [wiki("Стіг (Свидовець)", 48970686), wd("Q4442697")],
    commonsFile: "Svidovec2.JPG",
    search: { query: "гора Стіг Свидовець", match: /стіг|стог|стуг/i },
  },
];

const byGoogleId = new Map(PEAKS.filter((p) => p.googlePlaceId).map((p) => [p.googlePlaceId!, p]));

/** Вершина по id места Google (выдача api); нет — undefined. */
export const peakByGooglePlaceId = (id: string | null | undefined): PeakData | undefined =>
  id ? byGoogleId.get(id) : undefined;

/** Код подкатегории раздела. */
export const PEAKS_CATEGORY_CODE = "peaks";
