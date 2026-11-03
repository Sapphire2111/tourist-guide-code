import { describe, expect, it } from "vitest";
import { landmarkOf, tourLandmarkOf, visitEstimate, visitMinutes } from "./visit-duration.js";

const p = (category: string, ...names: string[]) => ({ category, names });

describe("visitEstimate — реалистичная длительность", () => {
  it("вершины — часы, а не 1:30 по категории", () => {
    expect(visitMinutes(p("nature", "Гора Хом'як"))).toBeGreaterThanOrEqual(360);
    expect(visitMinutes(p("nature", "Хомʼяк"))).toBeLessThanOrEqual(420);
    expect(visitMinutes(p("sights", "Гора Говерла"))).toBeGreaterThanOrEqual(360);
    expect(visitMinutes(p("sights", "Говерла"))).toBeLessThanOrEqual(480);
    expect(visitMinutes(p("nature", "гора Синяк"))).toBeGreaterThanOrEqual(300);
    expect(visitMinutes(p("sights", "Підйом на г. Синяк"))).toBe(visitMinutes(p("nature", "Hora Synyak")));
    expect(visitEstimate(p("active", "Гора Маковиця"))).toMatchObject({ kind: "hike", fixed: true });
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
