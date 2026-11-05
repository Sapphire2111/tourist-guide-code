// onPartial в search: сбой догрузки страницы, обрезка по max, ровно max без продолжения.
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type ApiSchemas } from "@tg/api-client";
import { createGuideApi } from "./guide-api.js";

const REGION = "00000000-0000-4000-8000-0000000000a1";
const ID = "00000000-0000-4000-8000-000000000201";
const dto = {
  id: ID,
  categoryId: ID,
  name: { uk: "Садиба" },
  address: null,
  location: { lon: 24.56, lat: 48.45 },
  distanceMeters: null,
  recommended: false,
  adLabel: null,
  openNow: null,
  phone: null,
  coverPhoto: null,
  cover: null,
} as ApiSchemas["PlaceSummaryDto"];

const apiWith = (fetch: (req: Request) => Promise<Response>) =>
  createGuideApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
const page = (nextOffset: number | null) =>
  Response.json({ items: [dto, dto], nextOffset, radiusMeters: null });

describe("search: onPartial", () => {
  it("сбой догрузки второй страницы — failed, отдаётся уже загруженное", async () => {
    const f = vi.fn(async (req: Request) => {
      if (new URL(req.url).searchParams.get("offset")) throw new Error("net");
      return page(2);
    });
    const onPartial = vi.fn();
    expect(await apiWith(f).search({ limit: 2, max: 6, onPartial })).toHaveLength(2);
    expect(onPartial).toHaveBeenCalledWith("failed");
  });

  it("дошли до max, а на сервере есть ещё — truncated", async () => {
    const onPartial = vi.fn();
    const api = apiWith(async () => page(99));
    expect(await api.search({ limit: 2, max: 2, onPartial })).toHaveLength(2);
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith("truncated");
  });

  it("ровно max и nextOffset null — выдача полная", async () => {
    const onPartial = vi.fn();
    const api = apiWith(async () => page(null));
    expect(await api.search({ limit: 2, max: 2, onPartial })).toHaveLength(2);
    expect(onPartial).not.toHaveBeenCalled();
  });
});

describe("акції: адаптер", () => {
  it("hasOffer і offers из DTO; api без полей — false и пусто", async () => {
    const { summaryOf, cardOf } = await import("./guide-api.js");
    expect(summaryOf({ ...dto, hasOffer: true }).hasOffer).toBe(true);
    expect(summaryOf(dto).hasOffer).toBe(false);
    // «Партнер гіда»: из DTO; api старее поля — false.
    expect(summaryOf({ ...dto, partner: true }).partner).toBe(true);
    expect(summaryOf(dto).partner).toBe(false);
    const card = {
      ...dto,
      regionId: "r",
      category: { id: ID, parentId: null, name: { uk: "К" }, icon: null },
      description: null,
      descriptionAuto: false,
      website: null,
      telegram: null,
      verifiedAt: null,
      photos: [],
      tags: [],
      schedule: { timezone: "Europe/Kyiv", weekly: [], exceptions: [] },
      openUntil: null,
      favorite: null,
    } as unknown as ApiSchemas["PlaceCardDto"];
    expect(cardOf(card).offers).toEqual([]);
    const o = {
      id: ID,
      title: { uk: "A" },
      description: null,
      startsAt: null,
      endsAt: "2099-01-01T00:00:00Z",
    };
    expect(cardOf({ ...card, offers: [o] }).offers).toEqual([o]);
  });
});
