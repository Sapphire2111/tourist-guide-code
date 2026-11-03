import { describe, expect, it } from "vitest";
import { isMountainHike, landmarkOf, tourLandmarkOf, visitEstimate, visitMinutes } from "./visit-duration.js";
import { placeFitsSeason } from "./season.js";

const p = (category: string, ...names: string[]) => ({ category, names });

describe("visitEstimate — реалистичная длительность", () => {
  it("вершины — часы, а не 1:30 по категории", () => {
    expect(visitMinutes(p("nature", "Гора Хом'як"))).toBeGreaterThanOrEqual(360);
    expect(visitMinutes(p("nature", "Хомʼяк"))).toBeLessThanOrEqual(420);
    expect(visitMinutes(p("sights", "Гора Говерла"))).toBeGreaterThanOrEqual(360);
    expect(visitMinutes(p("sights", "Говерла"))).toBeLessThanOrEqual(480);
    expect(visitMinutes(p("nature", "гора Синяк"))).toBeGreaterThanOrEqual(300);
    expect(visitMinutes(p("sights", "Підйом на г. Синяк"))).toBe(visitMinutes(p("nature", "Hora Synyak")));
    expect(visitEstimate(p("sights", "Підйом на гору Маковиця"))).toMatchObject({
      kind: "hike",
      fixed: true,
    });
    expect(visitMinutes(p("nature", "Пікуй"))).toBeGreaterThanOrEqual(300);
    expect(visitMinutes(p("nature", "Петрос"))).toBeGreaterThanOrEqual(420);
    expect(visitMinutes(p("nature", "Близниці"))).toBeGreaterThanOrEqual(300);
  });

  it("водоспады и прогулянки — коротко", () => {
    expect(visitMinutes(p("nature", "Водоспад Пробій"))).toBeLessThanOrEqual(60);
    expect(visitMinutes(p("nature", "Скелі Довбуша"))).toBeGreaterThanOrEqual(90);
    expect(visitMinutes(p("nature", "Водоспад Капливець"))).toBeLessThanOrEqual(90);
  });

  it("отель, колиба, кафе и оглядовий майданчик с вершиной в названии — не маршрут", () => {
    expect(landmarkOf(p("hotels", "Готельний комплекс «Під Хомяком»"))).toBeNull();
    expect(landmarkOf(p("kolyby", "Колиба «Під Хомʼяком»"))).toBeNull();
    expect(landmarkOf(p("cafes", "Говерла"))).toBeNull();
    expect(landmarkOf(p("active", "Вид на Говерлу та Петром"))).toBeNull();
    expect(landmarkOf(p("active", "Панорама Говерла и Петрос"))).toBeNull();
    expect(landmarkOf(p("chany", "ДОВБУШЕВІ БАНІ"))).toBeNull();
  });

  it("ложные совпадения: прокат, тур, джип, квадро, отель, музей, памятник с вершиной в названии — не маршрут", () => {
    for (const name of [
      "Джип-тур на Говерлу",
      "Квадроцикли на Синяк",
      "Kvadro Tour Hoverla",
      "Прокат спорядження Хом'як",
      "Готель Петрос",
      "Hotel Synyak",
      "Музей Олекси Довбуша",
      "Пам'ятник Довбушу",
      "Кафе Маковиця",
    ])
      expect(landmarkOf(p("sights", name)), name).toBeNull();
    // active — только по названию активности, не маршрут.
    expect(landmarkOf(p("active", "Гора Маковиця"))).toBeNull();
    expect(visitEstimate(p("active", "Джип тури на Говерлу"))).toMatchObject({ minutes: 240, fixed: false });
    // Довбуш — только скелі/стежка/камінь.
    expect(landmarkOf(p("sights", "Камінь Довбуша"))?.code).toBe("dovbush-rocks");
    expect(landmarkOf(p("sights", "Церква Довбуша"))).toBeNull();
    // Манявський водоспад и скит — разные места.
    expect(landmarkOf(p("nature", "Манявський водоспад"))?.code).toBe("maniava-waterfall");
    expect(landmarkOf(p("sights", "Манявський скит"))?.code).toBe("maniava-skete");
    expect(landmarkOf(p("sights", "Маняви центр"))).toBeNull();
  });

  it("турфирма с вершинами — самый короткий из названных маршрутов + трансфер", () => {
    const tour = p("excursions", "ЕКСКУРСІЇ ТА ТРАНСФЕРИ ЩОДНЯ НА ГОРУ ГОВЕРЛА ПЕТРОС ПІП ІВАН ХОМЯК");
    expect(tourLandmarkOf(tour)?.code).toBe("khomiak");
    expect(visitEstimate(tour)).toMatchObject({ kind: "tour", fixed: true });
    expect(visitMinutes(tour)).toBe(390 + 120);
  });

  it("активности по названию и категории по умолчанию", () => {
    expect(visitMinutes(p("active", "Джип тури Микуличин"))).toBe(240);
    expect(visitMinutes(p("active", "Kvadro Life Yaremche"))).toBe(150);
    expect(visitMinutes(p("active", "Кінні прогулянки"))).toBe(120);
    expect(visitMinutes(p("chany", "Чани у Петра"))).toBe(120);
    expect(visitMinutes(p("restaurants", "Ресторан"))).toBe(75);
    expect(visitMinutes(p("unknown", "Щось"))).toBe(60);
  });
});

describe("isMountainHike — одно определение для сезона и погоды", () => {
  const tags = { tags: [] as string[] };
  it("Пікуй, Синяк, Hoverla, «Похід на Говерлу», полонина, турфирма на вершину — горный; зимой не предлагаются", () => {
    for (const x of [
      p("nature", "Пікуй"),
      p("nature", "гора Синяк"),
      p("nature", "Hoverla peak"),
      p("active", "Похід на Говерлу"),
      p("sights", "Полонина Перці"),
      p("excursions", "ЕКСКУРСІЇ ТА ТРАНСФЕРИ ЩОДНЯ НА ГОРУ ГОВЕРЛА"),
    ]) {
      expect(isMountainHike(x), x.names[0]).toBe(true);
      expect(placeFitsSeason({ ...x, ...tags }, "winter"), x.names[0]).toBe(false);
      expect(placeFitsSeason({ ...x, ...tags }, "summer"), x.names[0]).toBe(true);
    }
  });

  it("Прокат Говерла, Готель Говерла, кафе, музей, вид на гору, водоспад — не горный и зимой видны", () => {
    for (const x of [
      p("active", "Прокат Говерла"),
      p("hotels", "Готель Говерла"),
      p("sights", "Готель Говерла"),
      p("cafes", "Кафе Гора"),
      p("museums", "Музей Говерли"),
      p("active", "Вид на Говерлу та Петром"),
      p("nature", "Водоспад Пробій"),
      p("nature", "Горіховий гай"),
      p("active", "Джип-тур на Синяк"),
    ]) {
      expect(isMountainHike(x), x.names[0]).toBe(false);
      expect(placeFitsSeason({ ...x, ...tags }, "winter"), x.names[0]).toBe(true);
    }
    // Стежка Довбуша — горная для погоды, но маршрут уместен и зимой.
    expect(isMountainHike(p("sights", "Стежка Довбуша"))).toBe(true);
    expect(placeFitsSeason({ ...p("sights", "Стежка Довбуша"), ...tags }, "winter")).toBe(true);
  });
});
