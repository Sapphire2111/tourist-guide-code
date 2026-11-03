// Заказы на сценарии (brief): район × тема × сезон × дни. Детерминированный список — повторный прогон даёт те же коды
// (уже записанные пропускаются), --count N берёт первые N по кругу тем (разнообразие с первых сценариев).
import type { LonLat, ScenarioSeason } from "../db/index.js";
import { landmarkOf, type ScenarioTag } from "../modules/planner/index.js";
import type { GenPlace } from "./catalog.js";

export type ThemeCode =
  | "summit"
  | "maniava"
  | "sheshory"
  | "kosiv-market"
  | "waterfalls"
  | "dovbush"
  | "peak"
  | "guided-peak"
  | "culture"
  | "gastro"
  | "relax"
  | "ski"
  | "rain"
  | "kids"
  | "no-car"
  | "romantic"
  | "active"
  | "mix";

export type Theme = {
  code: ThemeCode;
  /** Задание модели (uk). */
  ask: string;
  /** Категории в центре темы (кандидаты — сначала они). */
  focus: readonly string[];
  tags: readonly ScenarioTag[];
  /** Варианты сезонов (пустой — круглый год). */
  seasons: readonly (readonly ScenarioSeason[])[];
  days: readonly number[];
  /** Районы (коды населённых пунктов); не задано — все. */
  areas?: readonly string[];
  /** Радиус подбора от центра района, м. */
  radius: number;
  noCar?: boolean;
  kids?: boolean;
  rain?: boolean;
};

const ALL_YEAR: readonly ScenarioSeason[] = [];
const WARM: readonly ScenarioSeason[] = ["spring", "summer", "autumn"];
const HIKING: readonly ScenarioSeason[] = ["summer", "autumn"];
const SEE = ["nature", "sights", "museums"] as const;

export const THEMES: readonly Theme[] = [
  {
    code: "waterfalls",
    ask: "Водоспади й природа: 2–4 водоспади або природні місця з прогулянкою, обід поруч, увечері — відпочинок.",
    focus: ["nature", "sights"],
    tags: ["waterfalls"],
    seasons: [WARM, ["winter"]],
    days: [1],
    radius: 15_000,
  },
  {
    code: "dovbush",
    ask: "Стежками Довбуша: скелі й стежка Довбуша (прогулянка 2–3 год), водоспад, гуцульська кухня.",
    focus: ["nature", "sights", "museums"],
    tags: ["hiking", "culture"],
    seasons: [WARM, ALL_YEAR],
    days: [1],
    areas: ["yaremche", "mykulychyn"],
    radius: 12_000,
  },
  {
    code: "peak",
    ask:
      "Похід на вершину (один великий маршрут на весь день: Маковиця, Синяк тощо — із кандидатів з поміткою «похід»): " +
      "ранній старт, після спуску — вечеря та чан або SPA. Більше нічого великого цього дня.",
    focus: ["nature", "sights", "active"],
    tags: ["hiking", "mountains", "active"],
    seasons: [HIKING, ["summer"]],
    days: [1],
    radius: 25_000,
  },
  {
    code: "guided-peak",
    ask:
      "Екскурсія з гідом на вершину (Говерла, Петрос, Хом'як…) через турфірму з кандидатів категорії «excursions» з " +
      "вершиною в назві: це весь день; у примітці — бронювати заздалегідь. Увечері — вечеря та чан.",
    focus: ["excursions"],
    tags: ["excursion", "mountains", "hiking"],
    seasons: [HIKING],
    days: [1],
    areas: ["yaremche", "tatariv", "vorokhta"],
    radius: 15_000,
  },
  {
    code: "culture",
    ask: "Культура: музеї, церкви, пам'ятки, гуцульські ремесла й сувеніри, обід у колибі.",
    focus: ["museums", "sights", "markets", "souvenirs"],
    tags: ["culture"],
    seasons: [ALL_YEAR],
    days: [1],
    radius: 15_000,
  },
  {
    code: "gastro",
    ask: "Гастро-день: сніданок у кав'ярні, гуцульська кухня, ринок або сироварня, вечеря в колибі; між ними — легкі прогулянки.",
    focus: ["restaurants", "kolyby", "cafes", "markets"],
    tags: ["gastro"],
    seasons: [ALL_YEAR, ["winter"]],
    days: [1],
    radius: 12_000,
  },
  {
    code: "relax",
    ask: "Релакс: неспішний день — кава, коротка прогулянка, чани або SPA, вечеря.",
    focus: ["chany", "spa", "cafes"],
    tags: ["relax"],
    seasons: [["winter"], ["autumn"], ALL_YEAR],
    days: [1],
    radius: 12_000,
  },
  {
    code: "ski",
    ask: "Лижний день: гірськолижний комплекс (5–6 год), прокат або школа за потреби, обід, увечері — чан або SPA.",
    focus: ["ski-resorts", "ski-lifts", "ski-schools", "ski-rental"],
    tags: ["ski", "active"],
    seasons: [["winter"]],
    days: [1, 2],
    areas: ["polianytsia", "yablunytsia", "vorokhta", "tatariv"],
    radius: 15_000,
  },
  {
    code: "rain",
    ask: "Дощовий день: усе під дахом — музеї, кав'ярні, ресторани, чани чи SPA, сувенірні крамниці.",
    focus: ["museums", "cafes", "restaurants", "kolyby", "chany", "spa", "souvenirs"],
    tags: ["rain"],
    seasons: [ALL_YEAR],
    days: [1],
    radius: 15_000,
    rain: true,
  },
  {
    code: "kids",
    ask: "З дітьми: розваги й місця для дітей, короткі прогулянки (без довгих походів), обід, ранній вечір.",
    focus: ["kids", "entertainment", "museums", "nature", "active"],
    tags: ["kids"],
    seasons: [WARM, ["winter"]],
    days: [1, 2],
    radius: 15_000,
    kids: true,
  },
  {
    code: "no-car",
    ask: "Без авто: усе пішки поруч (до 2 км між пунктами), прогулянки, кава, обід, вечеря.",
    focus: [...SEE, "cafes", "markets", "souvenirs"],
    tags: ["no_car", "budget"],
    seasons: [ALL_YEAR],
    days: [1],
    radius: 2_500,
    noCar: true,
  },
  {
    code: "romantic",
    ask: "Романтичний день для двох: краєвиди й оглядові майданчики, кава, вечеря в ресторані, чан або SPA увечері.",
    focus: ["nature", "sights", "restaurants", "chany", "spa"],
    tags: ["romantic"],
    seasons: [ALL_YEAR, ["winter"]],
    days: [1, 2],
    radius: 15_000,
  },
  {
    code: "active",
    ask: "Активний день: квадроцикли або джип-тур, кінна прогулянка, роуп-джампінг чи зіплайн (2–3 активності), обід.",
    focus: ["active", "entertainment", "gear-rental"],
    tags: ["active"],
    seasons: [WARM, ["winter"]],
    days: [1],
    radius: 15_000,
  },
  {
    code: "mix",
    ask:
      "Кількаденний відпочинок: щодня свій район (переїзд — між днями, не всередині дня), природа й пам'ятки, " +
      "активність, гуцульська кухня, вечорами — чан або SPA. Не повторювати місця.",
    focus: [...SEE, "active", "chany", "spa", "markets"],
    tags: [],
    seasons: [["winter"], ["spring"], ["summer"], ["autumn"]],
    days: [2, 3],
    areas: ["yaremche", "polianytsia", "vorokhta"],
    radius: 25_000,
  },
];

export const AREAS = [
  "yaremche",
  "mykulychyn",
  "tatariv",
  "polianytsia",
  "vorokhta",
  "yablunytsia",
  "kosiv",
] as const;
/** Охват из задания владельца, которого нет в каталоге населённых пунктов (раньше — Косів; теперь есть). */
export const WANTED_AREAS: Readonly<Record<string, string>> = {};

/** Место-цель заказа (вершина, скит, водоспад, ринок): центр подбора и обязательный пункт. */
export type BriefTarget = { placeId: string; name: string; location: LonLat };

export type Brief = {
  /** Код сценария (уникален, латиницей). */
  code: string;
  theme: Theme;
  area: string;
  seasons: readonly ScenarioSeason[];
  days: number;
  target?: BriefTarget;
};

const SEASON_CODE: Record<ScenarioSeason, string> = { winter: "w", spring: "sp", summer: "s", autumn: "a" };
const seasonsCode = (s: readonly ScenarioSeason[]) =>
  s.length ? s.map((x) => SEASON_CODE[x]).join("") : "all";

/**
 * Темы с обязательным местом из каталога (просьба владельца 03.11.2026): вершины (Говерла, Хом'як, Петрос, Піп Іван,
 * Синяк…) — летом и ранней осенью, Манявський скит (+ водоспад, если есть), Шешори, суботній ринок у Косові.
 */
type TargetTheme = Theme & { key: (p: GenPlace) => string | null };

export const TARGET_THEMES: readonly TargetTheme[] = [
  {
    code: "summit",
    ask:
      "Похід на вершину (обовʼязковий пункт — сама вершина): весь день, старт рано (до 8:00–9:00) від звичайної точки " +
      "старту, з запасом часу на підйом і спуск до заходу сонця; у примітці — звідки стартувати, вода/їжа/дощовик, що " +
      "можна піти з гідом (турфірма зі списку, якщо є). Після спуску — вечеря поруч і чан/SPA. Більше нічого великого.",
    focus: ["nature", "sights", "excursions"],
    tags: ["hiking", "mountains", "active"],
    seasons: [["summer", "autumn"], ["summer"]],
    days: [1],
    radius: 30_000,
    key: (p) => {
      const lm = landmarkOf(p);
      return lm?.kind === "hike" && lm.highMountain ? lm.code : null;
    },
  },
  {
    code: "maniava",
    ask:
      "Манявський скит: дорога (далеко — врахуй час), огляд скиту, Манявський водоспад, якщо він є у списку, обід поруч; " +
      "решта дня — неспішно.",
    focus: ["sights", "nature", "museums"],
    tags: ["culture", "waterfalls"],
    seasons: [WARM, ALL_YEAR],
    days: [1],
    radius: 25_000,
    key: (p) => (landmarkOf(p)?.code === "maniava-skete" ? "maniava" : null),
  },
  {
    code: "sheshory",
    ask: "Шешори й Пістинь: водоспади на Пістиньці, прогулянка, гуцульська кухня; Косів поруч — музей чи ремесла.",
    focus: ["nature", "sights", "museums", "markets"],
    tags: ["waterfalls", "culture"],
    seasons: [WARM],
    days: [1],
    radius: 20_000,
    key: (p) =>
      p.category === "nature" && p.names.some((n) => /шешор|пістин/iu.test(n)) ? "sheshory" : null,
  },
  {
    code: "kosiv-market",
    ask:
      "Субота в Косові: Косівський ринок (працює лише в суботу, зранку — приходити рано), музеї Гуцульщини й народної " +
      "творчості, обід. У назві й описі вкажи, що це план на суботу.",
    focus: ["markets", "museums", "sights", "souvenirs"],
    tags: ["culture", "gastro"],
    seasons: [ALL_YEAR],
    days: [1],
    radius: 15_000,
    key: (p) => (p.category === "markets" && p.names.some((n) => /косів/iu.test(n)) ? "kosiv-market" : null),
  },
];

/** Порядок вершин в прогоне: сначала главные (Говерла, Хом'як, Петрос, Піп Іван), затем остальные. */
const SUMMIT_ORDER = ["hoverla", "khomiak", "petros", "pip-ivan", "synyak", "makovytsia", "yavirnyk"];
const rank = (k: string) => (SUMMIT_ORDER.includes(k) ? SUMMIT_ORDER.indexOf(k) : SUMMIT_ORDER.length);

/** Заказы с местом-целью: по одному месту на ключ (лучшее по популярности). */
export function targetBriefs(places: readonly GenPlace[]): Brief[] {
  const out: Brief[] = [];
  for (const theme of TARGET_THEMES) {
    const best = new Map<string, GenPlace>();
    for (const p of places) {
      const k = theme.key(p);
      if (!k) continue;
      const cur = best.get(k);
      if (!cur || (p.ratingCount ?? 0) > (cur.ratingCount ?? 0)) best.set(k, p);
    }
    for (const [k, p] of [...best.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)))
      for (const seasons of theme.seasons)
        for (const days of theme.days)
          out.push({
            // ai-summit-hoverla-s-1d, ai-maniava-spsa-1d, ai-kosiv-market-all-1d
            code: `ai-${theme.code === "summit" ? `summit-${k}` : k}-${seasonsCode(seasons)}-${days}d`,
            theme,
            area: p.locality ?? "region",
            seasons,
            days,
            target: { placeId: p.id, name: p.name, location: p.location },
          });
  }
  return out;
}

/**
 * Все заказы по кругу тем: сначала по одному каждой темы, затем следующие варианты. Заказы с местом-целью
 * (targets — из каталога, targetBriefs) идут в круг как отдельные темы.
 */
export function allBriefs(areas: readonly string[] = AREAS, targets: readonly Brief[] = []): Brief[] {
  const perTheme = THEMES.map((theme) => {
    const out: Brief[] = [];
    for (const area of theme.areas ?? areas) {
      if (!areas.includes(area)) continue;
      for (const seasons of theme.seasons)
        for (const days of theme.days)
          out.push({
            code: `ai-${area}-${theme.code}-${seasonsCode(seasons)}-${days}d`,
            theme,
            area,
            seasons,
            days,
          });
    }
    return out;
  });
  const byTheme = new Map<string, Brief[]>();
  for (const t of targets) byTheme.set(t.theme.code, [...(byTheme.get(t.theme.code) ?? []), t]);
  const lists = [...byTheme.values(), ...perTheme];
  const out: Brief[] = [];
  for (let round = 0; lists.some((l) => l.length > round); round++)
    for (const list of lists) if (list[round]) out.push(list[round]!);
  return out;
}
