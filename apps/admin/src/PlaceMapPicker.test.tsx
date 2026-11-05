// Выбор места на карте в форме «Новий QR-код»: загрузчик Google Maps подменён фейком — запрос мест по рамке карты
// после остановки, подсказка об обрезке, клик по маркеру → «Обрати» → место в списке; без ключа — пояснение.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App.js";
import { createAdminApi, setToken } from "./api.js";
import { setMapsConfigForTests } from "./map-config.js";
import { bboxOf } from "./PlaceMap.js";

const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const SESSION = {
  id: "00000000-0000-4000-8000-0000000000e1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  channel: "admin_web",
  expiresAt: "2099-01-01T00:00:00Z",
  activeRegionId: null,
  grants: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "REGION_ADMIN",
      scopeType: "REGION",
      scopeId: REGION_ID,
      regionId: REGION_ID,
      validUntil: null,
    },
  ],
};
const place = (n: number, name: string, location: { lon: number; lat: number } | null) => ({
  id: `00000000-0000-4000-8000-00000000c00${n}`,
  regionId: REGION_ID,
  categoryId: "00000000-0000-4000-8000-0000000000c9",
  localityId: null,
  name: { uk: name },
  description: null,
  address: null,
  location,
  status: "published",
});
const SEARCHED = place(1, "Кафе з пошуку", { lon: 24.5, lat: 48.4 });
const ON_MAP = place(2, "Колиба на мапі", { lon: 25.0, lat: 48.3 });

const maps = vi.hoisted(() => ({
  idle: [] as (() => void)[],
  centers: [] as unknown[],
  markers: [] as { title: string; map: unknown; click?: () => void }[],
}));

vi.mock("./google-maps.js", () => {
  class FakeMap {
    addListener(name: string, f: () => void) {
      if (name === "idle") maps.idle.push(f);
      return { remove: () => undefined };
    }
    setCenter(c: unknown) {
      maps.centers.push(c);
    }
    setZoom() {}
    getBounds() {
      return {
        getNorthEast: () => ({ lat: () => 48.4, lng: () => 25.2 }),
        getSouthWest: () => ({ lat: () => 48.2, lng: () => 24.9 }),
      };
    }
  }
  class FakeMarker {
    title: string;
    map: unknown;
    click?: () => void;
    constructor(o: { title: string; map: unknown }) {
      this.title = o.title;
      this.map = o.map;
      maps.markers.push(this);
    }
    addEventListener(name: string, f: () => void) {
      if (name === "gmp-click") this.click = f;
    }
  }
  const libs = { core: {}, maps: { Map: FakeMap }, marker: { AdvancedMarkerElement: FakeMarker } };
  return {
    loadMapsApi: () => Promise.resolve(libs),
    acquireMap: () => ({ div: document.createElement("div"), map: new FakeMap(), busy: true }),
    releaseMap: () => undefined,
    onMapsAuthFailure: () => () => undefined,
  };
});

function fakeApi() {
  const calls: { path: string; query: URLSearchParams }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    calls.push({ path: url.pathname, query: url.searchParams });
    const json =
      url.pathname === "/auth/session"
        ? SESSION
        : url.pathname === "/admin/places" && url.searchParams.has("minLat")
          ? { items: [ON_MAP], nextCursor: "more" }
          : url.pathname === "/admin/places"
            ? { items: [SEARCHED], nextCursor: null }
            : { items: [], nextCursor: null };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createAdminApi("http://api.test", fetch as unknown as typeof globalThis.fetch), calls };
}

const wait = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));

async function open(api: ReturnType<typeof fakeApi>["api"]) {
  window.location.hash = "#/qr";
  render(<App api={api} />);
  await wait();
  await wait();
}

beforeEach(() => {
  setToken("tok");
  maps.idle.length = 0;
  maps.centers.length = 0;
  maps.markers.length = 0;
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
  setToken(null);
  setMapsConfigForTests({ key: "" });
});

describe("выбор места на карте (QR)", () => {
  it("рамка карты → запрос с bbox и limit 100; маркер → «Обрати» → место в списке, даже не из поиска", async () => {
    setMapsConfigForTests({ key: "test-key" });
    const { api, calls } = fakeApi();
    await open(api);
    const select = screen.getByLabelText("Місце каталогу") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toContain("Кафе з пошуку");
    expect(screen.getByRole("link", { name: "Немає в каталозі? Додати місце" }).getAttribute("href")).toBe(
      "#/places/new",
    );

    fireEvent.click(screen.getByRole("button", { name: "Обрати на мапі" }));
    await screen.findByTestId("place-map");
    await wait();
    // Ничего не выбрано — центр региона.
    expect(maps.centers).toEqual([{ lat: 48.31, lng: 25.09 }]);
    expect(maps.idle).toHaveLength(1);
    // Несколько остановок подряд — один запрос (задержка).
    maps.idle[0]!();
    maps.idle[0]!();
    await wait(350);
    const bboxCalls = calls.filter((c) => c.path === "/admin/places" && c.query.has("minLat"));
    expect(bboxCalls).toHaveLength(1);
    expect(Object.fromEntries(bboxCalls[0]!.query)).toEqual({
      limit: "100",
      minLat: "48.2",
      maxLat: "48.4",
      minLng: "24.9",
      maxLng: "25.2",
    });
    expect(screen.getByText("Показано перші 100 місць — наблизьте мапу, щоб побачити всі.")).toBeDefined();
    expect(maps.markers.map((m) => m.title)).toEqual(["Колиба на мапі"]);

    act(() => maps.markers[0]!.click!());
    expect(screen.getByText("Колиба на мапі")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Обрати" }));
    await wait();
    expect(select.value).toBe(ON_MAP.id);
    expect(select.options[select.selectedIndex]!.text).toBe("Колиба на мапі");
    // Панель закрылась, маркеры сняты с карты.
    expect(screen.queryByTestId("place-map")).toBeNull();
    expect(maps.markers[0]!.map).toBeNull();

    // Повторное открытие — центр на выбранном месте.
    fireEvent.click(screen.getByRole("button", { name: "Обрати на мапі" }));
    await screen.findByTestId("place-map");
    await wait();
    expect(maps.centers.at(-1)).toEqual({ lat: 48.3, lng: 25.0 });
  });

  it("без ключа Google Maps — пояснение вместо кнопки, поиск по названию работает", async () => {
    const { api } = fakeApi();
    await open(api);
    expect(screen.queryByRole("button", { name: "Обрати на мапі" })).toBeNull();
    expect(screen.getByText(/Мапа недоступна: не налаштовано ключ Google Maps/)).toBeDefined();
    const select = screen.getByLabelText("Місце каталогу") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toContain("Кафе з пошуку");
  });

  it("bboxOf: границы карты; через антимеридиан — вся долгота", () => {
    const b = (sw: [number, number], ne: [number, number]) =>
      ({
        getSouthWest: () => ({ lat: () => sw[0], lng: () => sw[1] }),
        getNorthEast: () => ({ lat: () => ne[0], lng: () => ne[1] }),
      }) as unknown as google.maps.LatLngBounds;
    expect(bboxOf(b([48.2, 24.9], [48.4, 25.2]))).toEqual({
      minLat: 48.2,
      maxLat: 48.4,
      minLng: 24.9,
      maxLng: 25.2,
    });
    expect(bboxOf(b([-10, 170], [10, -170]))).toEqual({ minLat: -10, maxLat: 10, minLng: -180, maxLng: 180 });
  });
});
