// Что из задания владельца есть в каталоге, а чего нет (не выдумываем — сообщаем в отчёте): вершины, водоспады,
// Манявський скит, Довбуш, ринки Косова. Ищется по названию из Google в категориях самих мест (не отель «Говерла»).
import { landmarkOf, LANDMARKS } from "../modules/planner/index.js";
import type { GenCatalog, GenPlace } from "./catalog.js";

type Wanted = { name: string; match: (p: GenPlace) => boolean };

const byLandmark = (code: string) => (p: GenPlace) => landmarkOf(p)?.code === code;
const inCats = (cats: readonly string[], re: RegExp) => (p: GenPlace) =>
  cats.includes(p.category) && p.names.some((n) => re.test(n));

export const WANTED: readonly Wanted[] = [
  ...LANDMARKS.filter((l) => !["huk", "dovbush-rocks", "zhenets"].includes(l.code)).map((l) => ({
    name: l.name,
    match: byLandmark(l.code),
  })),
  { name: "Скелі Довбуша", match: inCats(["nature", "sights"], /скел\p{L}*\s+довбуш|dovbush\s+rocks/iu) },
  // Решение владельца: Гук в Яремче и есть Женецький Гук — один пункт задания, под любым из двух названий.
  {
    name: "Водоспад Женецький Гук (Гук)",
    match: (p) =>
      byLandmark("zhenets")(p) ||
      inCats(["nature", "sights"], /водоспад\s+гук|гук\s+водоспад|huk\s+waterfall/iu)(p),
  },
  { name: "Гірськолижний курорт Буковель", match: inCats(["ski-resorts"], /буковел|bukovel/iu) },
  {
    name: "Ринок у Косові",
    match: (p) => p.category === "markets" && p.names.some((n) => /косів|kosiv/iu.test(n)),
  },
  {
    name: "Музей у Косові",
    match: (p) => p.category === "museums" && p.names.some((n) => /косів|kosiv/iu.test(n)),
  },
  { name: "Сувенірний ринок у Яремчі", match: (p) => p.category === "markets" && p.locality === "yaremche" },
];

export type WantedReport = { name: string; found: string[] }[];

/** Найденные места (до 3 названий) по каждому пункту задания; found пустой — в каталоге нет. */
export function wantedReport(catalog: GenCatalog): WantedReport {
  return WANTED.map((w) => ({
    name: w.name,
    found: catalog.places
      .filter(w.match)
      .slice(0, 3)
      .map((p) => `${p.name} (${p.category}${p.locality ? `, ${p.locality}` : ""})`),
  }));
}
