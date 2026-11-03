// Список мест для карты стабилен между рендерами: иначе карта сбрасывает охват и окно маркера на каждый шаг ползунка.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GuideProvider, type GuideEnv } from "./context.js";
import { ModernNearbyResults } from "./Nearby.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const seen: PlaceSummary[][] = [];
vi.mock("./MapSlot.js", () => ({
  MapSlot: ({ places }: { places: PlaceSummary[] }) => {
    seen.push(places);
    return <div data-testid="fake-map" />;
  },
  preloadMap: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  seen.length = 0;
});

const place = (id: string, name: string): PlaceSummary => ({
  id,
  name: { uk: name },
  categoryId: "c1",
  location: { lat: 48.45, lng: 24.56 },
  distanceMeters: 100,
  cover: null,
  openNow: true,
  recommended: false,
  adLabel: null,
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("ModernNearbyResults", () => {
  it("ссылка на visible не меняется при перерисовке без смены списка и фильтров", async () => {
    const api = {
      categories: vi.fn(async () => [
        { id: "c1", parentId: null, name: { uk: "Кафе" }, homeSection: "eat" as const },
      ]),
    } as unknown as GuideApi;
    const env = {
      api,
      analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
      base: null,
      regionId: "r",
      signedIn: true,
    } as unknown as GuideEnv;
    const list = [place("a", "Смерека"), place("b", "Гуцульська хата")];
    const ui = (radius: number) => (
      <GuideProvider value={env}>
        <ModernNearbyResults list={list} radius={radius} base={null} me={null} loading={false} />
      </GuideProvider>
    );
    const { rerender } = render(ui(500));
    await flush();
    const before = seen[seen.length - 1];
    rerender(ui(600));
    rerender(ui(700));
    expect(seen[seen.length - 1]).toBe(before);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Смер" } });
    expect(seen[seen.length - 1]).not.toBe(before);
    expect(seen[seen.length - 1]).toHaveLength(1);
  });
});
