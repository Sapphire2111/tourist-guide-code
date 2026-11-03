// Заказы на сценарии (brief): район × тема × сезон × дни. Детерминированный список — повторный прогон даёт те же коды
// (уже записанные пропускаются), --count N берёт первые N по кругу тем (разнообразие с первых сценариев).
import type { ScenarioSeason } from "../db/index.js";
import type { ScenarioTag } from "../modules/planner/index.js";

export type ThemeCode =
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

export const AREAS = ["yaremche", "mykulychyn", "tatariv", "polianytsia", "vorokhta", "yablunytsia"] as const;
/** Охват из задания владельца, которого нет в каталоге населённых пунктов (Косів и окрестности). */
export const WANTED_AREAS: Readonly<Record<string, string>> = { kosiv: "Косів і околиці" };

export type Brief = {
  /** Код сценария (уникален, латиницей). */
  code: string;
  theme: Theme;
  area: string;
  seasons: readonly ScenarioSeason[];
  days: number;
};

const SEASON_CODE: Record<ScenarioSeason, string> = { winter: "w", spring: "sp", summer: "s", autumn: "a" };
const seasonsCode = (s: readonly ScenarioSeason[]) =>
  s.length ? s.map((x) => SEASON_CODE[x]).join("") : "all";

/** Все заказы по кругу тем: сначала по одному каждой темы, затем следующие варианты. */
export function allBriefs(areas: readonly string[] = AREAS): Brief[] {
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
  const out: Brief[] = [];
  for (let round = 0; perTheme.some((l) => l.length > round); round++)
    for (const list of perTheme) if (list[round]) out.push(list[round]!);
  return out;
}
