// Unit: режим --real-places — выбор реального отеля и пунктов сценариев детерминирован и только из реальных мест.
import { describe, expect, it } from "vitest";
import { seedUuid } from "./ids.js";
import { SEED_PLACES } from "./seed-catalog.js";
import { SEED_SCENARIOS } from "./seed-host.js";
import {
  buildRealScenarioItems,
  pickRealHotel,
  QR_LABEL_MAX,
  qrLabel,
  realVenueColumns,
  SEED_REAL_HOTEL_GOOGLE_ID,
  type RealPlace,
} from "./seed-real-places.js";

let n = 0;
const place = (
  category: string,
  locality: string | null,
  name: string,
  googlePlaceId?: string,
): RealPlace => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  name,
  category,
  locality,
  googlePlaceId: googlePlaceId ?? `g${n}`,
});

const sofia = place("hotels", "yaremche", "Hotel Sofia, готель Софія", SEED_REAL_HOTEL_GOOGLE_ID);
const others = [
  place("hotels", "yaremche", "Ялинка"),
  place("hotels", "yaremche", "Арніка"),
  place("hotels", "tatariv", "Аве"),
  place("cafes", "yaremche", "Кава Б"),
  place("cafes", "yaremche", "Кава А"),
  place("cafes", "tatariv", "Кава Т"),
  place("restaurants", "polianytsia", "Ресторан П"),
  place("restaurants", "yaremche", "Ресторан Я"),
  place("nature", "yaremche", "Водоспад Пробій"),
  place("excursions", "yaremche", "Скелі"),
  place("kolyby", "mykulychyn", "Колиба М"),
  place("museums", "yaremche", "Музей"),
  place("chany", "tatariv", "Чан"),
];

describe("seed --real-places", () => {
  it("отель — по google_place_id, иначе первый по имени отель Яремче", () => {
    expect(pickRealHotel([...others, sofia])?.id).toBe(sofia.id);
    expect(pickRealHotel(others)?.name).toBe("Арніка");
    expect(pickRealHotel([...others].reverse())?.name).toBe("Арніка");
    expect(pickRealHotel(others.filter((p) => p.category !== "hotels"))).toBeNull();
  });

  it("пункты сценариев — только реальные места, детерминированно, без повторов и с позициями по дням", () => {
    const real = new Set([...others, sofia].map((p) => p.id));
    const demo = new Set(SEED_PLACES.map((p) => seedUuid(`catalog:a:place:${p.key}`)));
    for (const s of SEED_SCENARIOS) {
      const items = buildRealScenarioItems(s, others);
      expect(items, s.code).toEqual(buildRealScenarioItems(s, [...others].reverse()));
      expect(items.length, s.code).toBeGreaterThan(0);
      const ids = items.map((i) => i.placeId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const i of items) {
        expect(real.has(i.placeId)).toBe(true);
        expect(demo.has(i.placeId)).toBe(false);
        for (const a of i.alternatives) expect(real.has(a)).toBe(true);
      }
      for (const d of new Set(items.map((i) => i.day)))
        expect(items.filter((i) => i.day === d).map((i) => i.position)).toEqual(
          items.filter((i) => i.day === d).map((_, k) => k),
        );
    }
    // Категория без реальных мест (такси) — пункт пропущен; кафе — сначала Яремче по имени.
    const noCar = buildRealScenarioItems(SEED_SCENARIOS.find((s) => s.code === "no-car")!, others);
    expect(noCar.map((i) => others.find((p) => p.id === i.placeId)?.name)).toEqual([
      "Водоспад Пробій",
      "Кава А",
    ]);
  });

  it("метка QR — не длиннее лимита qr_points_label_check (по символам), короткая без изменений", () => {
    expect(qrLabel("Hotel Sofia (демо-QR)")).toBe("Hotel Sofia (демо-QR)");
    const long = qrLabel(`${"Я".repeat(250)} (демо-QR)`);
    expect([...long]).toHaveLength(QR_LABEL_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(qrLabel("😀".repeat(QR_LABEL_MAX))).toBe("😀".repeat(QR_LABEL_MAX));
  });

  it("«Про заклад» QR — только из google-места: без вымышленных описания и telegram", () => {
    const address = { uk: "вул. Свободи, 1, Яремче" };
    expect(
      realVenueColumns({
        name: "Hotel Sofia",
        address,
        phone: "+380671234567",
        website: "https://sofia.example",
      }),
    ).toEqual({
      venue_name_i18n: { uk: "Hotel Sofia" },
      venue_description_i18n: null,
      venue_address_i18n: address,
      venue_phone: "+380671234567",
      venue_website: "https://sofia.example",
      venue_telegram: null,
    });
    expect(realVenueColumns({ name: "H", address: null, phone: null, website: null })).toMatchObject({
      venue_address_i18n: null,
      venue_phone: null,
      venue_website: null,
    });
  });
});
