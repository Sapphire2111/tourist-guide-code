import { describe, expect, it } from "vitest";
import {
  categoriesRelated,
  compareNames,
  explicitGroups,
  findDuplicatePairs,
  findOutOfRegion,
  nameSimilarity,
  normalizeAddress,
  sameAddress,
  type CheckPlace,
} from "./checks.js";

const place = (id: string, over: Partial<CheckPlace> = {}): CheckPlace => ({
  id,
  name: "Місце",
  category: "kids",
  locality: "yaremche",
  address: null,
  at: { lon: 24.5394, lat: 48.4456 },
  ratingCount: 0,
  photos: 0,
  ...over,
});

/** Сдвиг точки на север, м. */
const north = (at: { lon: number; lat: number }, m: number) => ({ lon: at.lon, lat: at.lat + m / 111_195 });

describe("normalizeAddress", () => {
  it("улица — последнее слово без префикса, номер отдельно; страна, область, индекс, пункт отброшены", () => {
    expect(
      normalizeAddress("вулиця Михайла Грушевського, 12а, Яремче, Івано-Франківська область, Україна, 78500"),
    ).toEqual({ street: "грушевського", number: "12а" });
    expect(normalizeAddress("ул. Довгий Грунь 512, Яблуниця")).toEqual({ street: "грунь", number: "512" });
    expect(normalizeAddress("вулиця Свободи, 345/2, Яремче")).toEqual({ street: "свободи", number: "345/2" });
    expect(normalizeAddress("Вул.Горби 61б, Микуличин")).toEqual({ street: "горби", number: "61б" });
    expect(normalizeAddress("участок Щивки, буд. 1, прим. 5, Поляниця")).toEqual(
      normalizeAddress("участок Щивки, 1, приміщення 5, Поляниця"),
    );
  });

  it("«обл.», район, «р-н» отбрасываются; «урочище X» без номера — не улица", () => {
    expect(normalizeAddress("вул. Свободи, 5, Яремче, Івано-Франківська обл.")).toEqual({
      street: "свободи",
      number: "5",
    });
    expect(normalizeAddress("вул. Свободи, 5, Надвірнянський район")).toEqual({
      street: "свободи",
      number: "5",
    });
    expect(normalizeAddress("вул. Свободи, 5, Надвірнянський р-н")).toEqual({
      street: "свободи",
      number: "5",
    });
    expect(normalizeAddress("урочище Вишня, Поляниця")).toEqual({ street: null, number: null });
    expect(normalizeAddress("урочище Вишня, 8а, Поляниця")).toEqual({ street: "вишня", number: "8а" });
  });

  it("адрес из одного пункта или plus-кода — без улицы; пункты можно передать из БД", () => {
    expect(normalizeAddress("Яремче")).toEqual({ street: null, number: null });
    expect(normalizeAddress("9C64+M9, Поляниця")).toEqual({ street: null, number: null });
    expect(normalizeAddress(null)).toEqual({ street: null, number: null });
    expect(normalizeAddress("Шешори", new Set(["шешори"]))).toEqual({ street: null, number: null });
  });

  it("совпадение — только улица и номер; без номера или без улицы — никогда", () => {
    const a = normalizeAddress("вулиця Михайла Грушевського, 5, Яремче");
    expect(sameAddress(a, normalizeAddress("вул. Грушевського, 5, Яремче"))).toBe(true);
    expect(sameAddress(a, normalizeAddress("вулиця Грушевського, 7, Яремче"))).toBe(false);
    const noNumber = normalizeAddress("вулиця Грушевського, Яремче");
    expect(sameAddress(noNumber, noNumber)).toBe(false);
    expect(sameAddress(normalizeAddress("Яремче"), normalizeAddress("Яремче"))).toBe(false);
  });
});

describe("compareNames", () => {
  it("одинаковые после нормализации — 1 без блокеров; разные — мало", () => {
    expect(compareNames("Готель «Карпати»", "готель Карпати")).toEqual({ similarity: 1, blockers: [] });
    expect(nameSimilarity("Смерічка", "Ведмежий кут")).toBeLessThan(0.4);
    // Общее слово-тип не делает названия похожими.
    expect(nameSimilarity("Садиба Форесок", "Садиба «Топірець»")).toBeLessThan(0.4);
  });

  it("банкомат и відділення — разные типы, пара не явная", () => {
    const r = compareNames("Банкомат Ощадбанк", "Ощадбанк");
    expect(r.blockers.join()).toMatch(/разные типы.*банкомат/);
    expect(compareNames("Банкомат МТБ Банк", "МТБ Банк").blockers).not.toEqual([]);
  });

  it("разные номера в названиях — блокер", () => {
    expect(compareNames("Поштомат 5531", "Поштомат 5532").blockers.join()).toMatch(/разные номера/);
    expect(compareNames("Підйомник 7", "Підйомник 17").blockers.join()).toMatch(/разные номера/);
    expect(compareNames("Смерічка", "Смерічка 2").blockers.join()).toMatch(/разные номера/);
    expect(compareNames("Аптека №1", "Аптека № 12").blockers.join()).toMatch(/разные номера/);
  });

  it("только общие слова — похожесть не 1 и блокер", () => {
    const r = compareNames("Аптека", "Аптека");
    expect(r.similarity).toBeLessThanOrEqual(0.5);
    expect(r.blockers).toContain("в названии только общие слова");
    expect(compareNames("Кафе у Яремчі", "Ресторан у Яремчі").blockers).not.toEqual([]);
  });

  it("вложенность — похоже, но не явно", () => {
    const r = compareNames("Вольєрне господарство", "Вольєрне господарство Карпатського НПП");
    expect(r.similarity).toBe(0.9);
    expect(r.blockers).toContain("одно название внутри другого");
  });
});

describe("categoriesRelated", () => {
  it("та же или из одной группы", () => {
    expect(categoriesRelated("hotels", "sadyby")).toBe(true);
    expect(categoriesRelated("kids", "sights")).toBe(true);
    expect(categoriesRelated("hotels", "restaurants")).toBe(false);
  });
});

describe("findDuplicatePairs", () => {
  const zooA = place("a", {
    name: "Звіринець Карпатського НПП",
    address: "вулиця Михайла Грушевського, 3, Яремче",
  });
  const zooB = place("b", {
    name: "Звіринець Карпатського НПП",
    address: "вул. Грушевського, 3, Яремче",
    at: north(zooA.at!, 2),
  });

  it("2 м, тот же адрес с номером, то же название, та же категория — явный", () => {
    const [p, ...rest] = findDuplicatePairs([zooA, zooB]);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ verdict: "explicit", sameAddress: true });
    expect(p!.a.id).toBe("a");
  });

  it("звіринець без номера дома и с разными названиями — только спорный", () => {
    const a = place("a", {
      name: "Вольєрне господарство Карпатського НПП",
      address: "вулиця Михайла Грушевського, Яремче",
    });
    const b = place("b", {
      name: "Вольєрне господарство | Звіринець в Яремче",
      address: "вулиця Михайла Грушевського, Яремче",
      at: north(a.at!, 2),
    });
    expect(findDuplicatePairs([a, b])[0]).toMatchObject({ verdict: "disputed", sameAddress: false });
  });

  it("банкомат у відділення — не явный дубль", () => {
    const branch = place("br", { category: "atm", name: "Ощадбанк", address: "вулиця Свободи, 260, Яремче" });
    const atm = place("atm", {
      category: "atm",
      name: "Банкомат Ощадбанк",
      address: "вулиця Свободи, 260, Яремче",
      at: north(branch.at!, 5),
    });
    expect(findDuplicatePairs([branch, atm])[0]!.verdict).toBe("disputed");
  });

  it("разные номера в названиях рядом — не явный", () => {
    const a = place("p1", { category: "post", name: "Поштомат 5531", address: "вулиця Свободи, 1, Яремче" });
    const b = place("p2", {
      category: "post",
      name: "Поштомат 5532",
      address: "вулиця Свободи, 1, Яремче",
      at: north(a.at!, 3),
    });
    expect(findDuplicatePairs([a, b])[0]!.verdict).toBe("disputed");
  });

  it("дальше порога — не пара; дальше явного порога — спорный", () => {
    expect(findDuplicatePairs([zooA, { ...zooB, at: north(zooA.at!, 120) }])).toEqual([]);
    expect(findDuplicatePairs([zooA, { ...zooB, at: north(zooA.at!, 50) }])[0]!.verdict).toBe("disputed");
  });

  it("родственная категория — только спорный; чужая — не пара", () => {
    expect(findDuplicatePairs([zooA, { ...zooB, category: "sights" }])[0]!.verdict).toBe("disputed");
    expect(findDuplicatePairs([zooA, { ...zooB, category: "hotels" }])).toEqual([]);
  });

  it("разные заведения в одном доме с непохожими названиями — спорный, без адреса и похожести — не пара", () => {
    const h1 = place("h1", {
      category: "sadyby",
      name: "Садиба Смерічка",
      address: "вулиця Свободи, 10, Яремче",
    });
    const h2 = place("h2", {
      category: "sadyby",
      name: "Апартаменти Ведмежий кут",
      address: "вулиця Свободи, 10, Яремче",
      at: north(h1.at!, 5),
    });
    expect(findDuplicatePairs([h1, h2])[0]!.verdict).toBe("disputed");
    expect(findDuplicatePairs([h1, { ...h2, address: "Яремче" }])).toEqual([]);
  });

  it("одинаковые названия без адреса рядом — явный; тип только в одном названии — спорный", () => {
    const x = place("x", { category: "cafes", name: "Гуцулка", address: "Яремче" });
    const y = place("y", { category: "cafes", name: "Гуцулка", address: null, at: north(x.at!, 10) });
    expect(findDuplicatePairs([x, y])[0]!.verdict).toBe("explicit");
    expect(findDuplicatePairs([{ ...x, name: "Кафе Гуцулка" }, y])[0]!.verdict).toBe("disputed");
  });

  it("места без точки пропускаются", () => {
    expect(findDuplicatePairs([zooA, { ...zooB, at: null }])).toEqual([]);
  });
});

describe("explicitGroups", () => {
  it("группа сливается, только если все пары явные", () => {
    const a = place("a", { name: "Гуцулка" });
    const b = place("b", { name: "Гуцулка", at: north(a.at!, 10) });
    const c = place("c", { name: "Гуцулка", at: north(a.at!, 25) });
    const pairs = findDuplicatePairs([a, b, c]);
    expect(explicitGroups(pairs).groups.map((g) => g.map((p) => p.id).sort())).toEqual([["a", "b", "c"]]);
    // c дальше 30 м от a: пара a–c спорная — группа не сливается целиком.
    const far = place("c", { name: "Гуцулка", at: north(a.at!, 35) });
    const r = explicitGroups(findDuplicatePairs([a, b, far]));
    expect(r.groups).toEqual([]);
    expect(r.split.map((g) => g.map((p) => p.id).sort())).toEqual([["a", "b", "c"]]);
  });
});

describe("findOutOfRegion", () => {
  const circles = [{ code: "yaremche", at: { lon: 24.5547, lat: 48.4505 }, radiusM: 4500 }];
  const opts = { postcodePrefixes: ["785", "786"] };

  it("внутри круга с индексом региона — не находка", () => {
    expect(
      findOutOfRegion([place("in", { address: "вулиця Свободи, Яремче, 78500" })], circles, opts),
    ).toEqual([]);
  });

  it("далеко от всех кругов — явно; рядом за краем — спорно; вершина далеко — спорно", () => {
    const slavske = { lon: 23.4497, lat: 48.8496 };
    const r = findOutOfRegion(
      [
        place("far", { at: slavske, category: "ski-lifts" }),
        place("near", { at: north(circles[0]!.at, 6000) }),
        place("peak", { at: slavske, category: "peaks" }),
      ],
      circles,
      opts,
    );
    expect(r.map((o) => [o.place.id, o.verdict, o.nearest])).toEqual([
      ["far", "explicit", "yaremche"],
      ["near", "disputed", "yaremche"],
      ["peak", "disputed", "yaremche"],
    ]);
  });

  it("место без пункта далеко — только спорно (точечный импорт)", () => {
    const r = findOutOfRegion(
      [place("trip", { at: { lon: 23.1164, lat: 48.8559 }, locality: null })],
      circles,
      opts,
    );
    expect(r[0]).toMatchObject({ verdict: "disputed" });
    expect(r[0]!.reason).toMatch(/без пункта/);
  });

  it("место с пунктом без точки — не «далеко»", () => {
    expect(findOutOfRegion([place("noat", { at: null })], circles, opts)).toEqual([]);
  });

  it("чужой индекс и чужая область — только спорно (перевал на границе), явно — лишь по расстоянию", () => {
    const r = findOutOfRegion(
      [
        place("post", { address: "Укрпошта 77344, вулиця Грушевського" }),
        place("inside", { address: "Закарпатська область, Україна" }),
        place("oblast", { address: "Славське, Львівська обл., 82660", at: north(circles[0]!.at, 7000) }),
      ],
      circles,
      opts,
    );
    expect(r.map((o) => [o.place.id, o.verdict])).toEqual([
      ["post", "disputed"],
      ["inside", "disputed"],
      ["oblast", "disputed"],
    ]);
  });
});
