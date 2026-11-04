// Фильтр удобств «Де жити»: кнопка и нижний лист с флажками, выдача — со всеми отмеченными (tags), счётчики при
// открытии, удобства без мест скрыты, «Скинути», только в разделе stay; адаптер api (tags, tag-counts, reviewTags).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Analytics } from "./analytics.js";
import { AmenityFilter } from "./AmenityFilter.js";
import { Catalog } from "./Catalog.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { cardOf, createGuideApi } from "./guide-api.js";
import { LocationProvider } from "./LocationProvider.js";
import type { GuideApi, SearchParams } from "./types.js";

vi.mock("./MapSlot.js", () => ({ MapSlot: () => <div data-testid="map" /> }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const REGION = "00000000-0000-4000-8000-0000000000a1";
const STAY = "00000000-0000-4000-8000-000000000301";
const EAT = "00000000-0000-4000-8000-000000000302";
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const place = {
  id: "p1",
  name: { uk: "Садиба" },
  categoryId: STAY,
  location: { lat: 48.3, lng: 24.6 },
  distanceMeters: 1,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
};

function env(search: GuideApi["search"], tagCounts?: GuideApi["tagCounts"]): GuideEnv {
  const api = {
    categories: vi.fn(async () => [
      { id: STAY, parentId: null, name: { uk: "Де жити" }, homeSection: "stay" as const },
      { id: EAT, parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
    ]),
    localities: vi.fn(async () => []),
    search,
    ...(tagCounts ? { tagCounts } : {}),
  } as unknown as GuideApi;
  return {
    api,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
    base: null,
    regionId: REGION,
    signedIn: true,
  };
}

async function mount(section: "stay" | "eat", search: GuideApi["search"], tagCounts?: GuideApi["tagCounts"]) {
  render(
    <GuideProvider value={env(search, tagCounts)}>
      <LocationProvider>
        <Catalog section={section} />
      </LocationProvider>
    </GuideProvider>,
  );
  await flush();
  await flush();
}

describe("фильтр удобств «Де жити»", () => {
  it("отмеченные удобства уходят в поиск (И), счётчики грузятся при открытии, пустые удобства скрыты", async () => {
    const search = vi.fn(async (_p: SearchParams) => [place]);
    const tagCounts = vi.fn(async () => ({ pool: 12, sauna: 5, kids: 40 }));
    await mount("stay", search, tagCounts);
    expect(search.mock.calls.at(-1)![0].tags).toBeUndefined();
    const trigger = screen.getByTestId("amenity-filter");
    expect(trigger.textContent).toContain("Зручності");
    fireEvent.click(trigger);
    await flush();
    expect(tagCounts).toHaveBeenCalledWith({ categoryId: STAY });
    const sheet = screen.getByTestId("amenity-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    // Только удобства с местами; счётчик рядом.
    const boxes = within(sheet).getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).value)).toEqual(["pool", "sauna", "kids"]);
    expect(within(sheet).getByLabelText("місць: 12").textContent).toContain("12");
    fireEvent.click(within(sheet).getByLabelText(/Сауна/));
    fireEvent.click(within(sheet).getByLabelText(/Басейн/));
    await flush();
    // Порядок — как в списке, а не как нажимали.
    expect(search.mock.calls.at(-1)![0].tags).toEqual(["pool", "sauna"]);
    expect(trigger.textContent).toContain("Зручності · 2");
    expect(trigger.getAttribute("data-active")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Готово" }));
    expect(screen.queryByTestId("amenity-sheet")).toBeNull();
    // Повторное открытие — счётчики не перезапрашиваются (тот же раздел и локации).
    fireEvent.click(trigger);
    await flush();
    expect(tagCounts).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("amenity-reset"));
    await flush();
    expect(search.mock.calls.at(-1)![0].tags).toBeUndefined();
    expect(trigger.textContent).toMatch(/^Зручності▾$/);
  });

  it("пустая выдача с фильтром — «Скинути» снимает и удобства", async () => {
    const search = vi.fn(async (p: SearchParams) => (p.tags?.length ? [] : [place]));
    await mount("stay", search);
    fireEvent.click(screen.getByTestId("amenity-filter"));
    // api без счётчиков — показываются все удобства.
    expect(within(screen.getByTestId("amenity-sheet")).getAllByRole("checkbox")).toHaveLength(9);
    fireEvent.click(screen.getByLabelText(/Басейн/));
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(screen.queryByTestId("catalog-empty")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Скинути" }));
    await flush();
    expect(search.mock.calls.at(-1)![0].tags).toBeUndefined();
    expect(screen.queryByTestId("catalog-empty")).toBeNull();
  });

  it("в других разделах фильтра нет", async () => {
    await mount(
      "eat",
      vi.fn(async () => [place]),
    );
    expect(screen.queryByTestId("amenity-filter")).toBeNull();
  });

  it("отмеченное удобство без мест остаётся в списке (чтобы его можно было снять)", () => {
    render(<AmenityFilter value={["wifi"]} onChange={() => {}} counts={{ pool: 1 }} />);
    fireEvent.click(screen.getByTestId("amenity-filter"));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => [b.value, b.checked])).toEqual([
      ["pool", false],
      ["wifi", true],
    ]);
  });
});

describe("адаптер api: удобства", () => {
  it("search передаёт tags, tagCounts — /places/tag-counts → код → число", async () => {
    const GET = vi.fn(async (path: string) => ({
      data:
        path === "/places/tag-counts"
          ? { items: [{ code: "pool", name: { uk: "Басейн" }, count: 3 }] }
          : { items: [], nextOffset: null, radiusMeters: null },
      response: new Response(null, { status: 200 }),
    }));
    const api = createGuideApi({ GET } as never, REGION);
    await api.search({ categoryId: STAY, tags: ["pool", "sauna"] });
    expect(GET.mock.calls[0]).toEqual([
      "/places/search",
      expect.objectContaining({
        params: { query: expect.objectContaining({ category: STAY, tags: ["pool", "sauna"] }) },
      }),
    ]);
    await api.search({ categoryId: STAY, tags: [] });
    expect(
      (GET.mock.calls[1] as unknown as [string, { params: { query: object } }])[1].params.query,
    ).not.toHaveProperty("tags");
    expect(await api.tagCounts!({ categoryId: STAY, localityIds: ["l1"] })).toEqual({ pool: 3 });
    expect(GET).toHaveBeenLastCalledWith("/places/tag-counts", {
      params: { query: { regionId: REGION, category: STAY, localityIds: ["l1"] } },
    });
  });

  it("cardOf: теги источника reviews — отдельно (пометка «за відгуками Google»)", () => {
    const tag = (code: string, source: string) => ({
      id: code,
      code,
      name: { uk: code },
      group: "amenity",
      source,
    });
    const card = cardOf({
      id: "p1",
      name: { uk: "Садиба" },
      categoryId: STAY,
      address: null,
      location: null,
      distanceMeters: null,
      cover: null,
      openNow: null,
      recommended: false,
      adLabel: null,
      description: null,
      phone: null,
      website: null,
      telegram: null,
      photos: [],
      schedule: { timezone: "Europe/Kyiv", weekly: [], exceptions: [] },
      tags: [tag("kids", "import"), tag("pool", "reviews"), tag("wifi", "manual")],
      verifiedAt: null,
      openUntil: null,
      favorite: null,
    } as never);
    expect(card.tags).toEqual([{ uk: "kids" }, { uk: "wifi" }]);
    expect(card.reviewTags).toEqual([{ uk: "pool" }]);
  });
});
