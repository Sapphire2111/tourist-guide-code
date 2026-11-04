import { describe, expect, it } from "vitest";
import {
  categoriesRelated,
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

  it("адрес из одного пункта или plus-кода — без улицы", () => {
    expect(normalizeAddress("Яремче")).toEqual({ street: null, number: null });
    expect(normalizeAddress("9C64+M9, Поляниця")).toEqual({ street: null, number: null });
    expect(normalizeAddress(null)).toEqual({ street: null, number: null });
  });

  it("совпадение: одна улица и один номер (или оба без номера); без улицы — никогда", () => {
    const a = normalizeAddress("вулиця Михайла Грушевського, Яремче");
    expect(sameAddress(a, normalizeAddress("вул. Грушевського, Яремче"))).toBe(true);
    expect(sameAddress(a, normalizeAddress("вулиця Грушевського, 5, Яремче"))).toBe(false);
    expect(sameAddress(normalizeAddress("Яремче"), normalizeAddress("Яремче"))).toBe(false);
  });
});

describe("nameSimilarity", () => {
  it("одинаковые после нормализации и вложенные — 1; разные — мало", () => {
    expect(nameSimilarity("Готель «Карпати»", "готель Карпати")).toBe(1);
    expect(nameSimilarity("Вольєрне господарство", "Вольєрне господарство Карпатського НПП")).toBe(1);
    expect(nameSimilarity("Садиба Смерічка", "Садиба Ведмежий кут")).toBeLessThan(0.4);
  });

  it("общие слова (тип места, пункт) не делают названия похожими", () => {
    expect(nameSimilarity("Кафе у Яремчі", "Ресторан у Яремчі")).toBe(0);
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
    name: "Вольєрне господарство Карпатського НПП",
    address: "вулиця Михайла Грушевського, Яремче",
  });
  const zooB = place("b", {
    name: "Вольєрне господарство | Звіринець в Яремче",
    address: "вулиця Михайла Грушевського, Яремче",
    at: north(zooA.at!, 2),
  });

  it("звіринець: 2 м, тот же адрес, похожие названия, та же категория — явный", () => {
    const [p, ...rest] = findDuplicatePairs([zooA, zooB]);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ verdict: "explicit", sameAddress: true });
    expect(p!.a.id).toBe("a");
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

  it("почти одинаковые названия без адреса рядом — явный", () => {
    const x = place("x", { category: "cafes", name: "Кафе Гуцулка", address: "Яремче" });
    const y = place("y", { category: "cafes", name: "Гуцулка", address: null, at: north(x.at!, 10) });
    expect(findDuplicatePairs([x, y])[0]!.verdict).toBe("explicit");
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

  it("чужой индекс — спорно; чужая область: точка в круге — спорно, за краем — явно", () => {
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
      ["oblast", "explicit"],
    ]);
  });
});
