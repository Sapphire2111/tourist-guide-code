// Unit: экраны при возврате по истории — подраздел из другого региона не применяется; геолокация, начатая до ухода
// с «Поруч», не запрашивается снова без нажатия.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { currentEntryKey, writeSlot } from "./back.js";
import { noopAnalytics } from "./guide/analytics.js";
import { Catalog } from "./guide/Catalog.js";
import { GuideProvider, noopGuideApi, type GuideEnv } from "./guide/context.js";
import { LocationProvider } from "./guide/LocationProvider.js";
import { Nearby } from "./guide/Nearby.js";
import type { GuideApi } from "./guide/types.js";

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#/");
});

const env = (api: GuideApi): GuideEnv => ({
  api,
  analytics: noopAnalytics,
  base: null,
  regionId: "r",
  signedIn: false,
});

describe("Catalog при возврате", () => {
  const ROOT = "00000000-0000-4000-8000-000000000301";
  const SUB = "00000000-0000-4000-8000-000000000302";
  const mount = async (search: GuideApi["search"]) => {
    const api = {
      ...noopGuideApi(),
      categories: vi.fn(async () => [
        { id: ROOT, parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
        { id: SUB, parentId: ROOT, name: { uk: "Кав'ярні" } },
      ]),
      search,
    } as unknown as GuideApi;
    render(
      <I18nProvider locale="uk">
        <GuideProvider value={env(api)}>
          <LocationProvider>
            <Catalog section="eat" />
          </LocationProvider>
        </GuideProvider>
      </I18nProvider>,
    );
    await flush();
    await flush();
  };

  it("сохранённого подраздела нет в справочнике — раздел целиком", async () => {
    writeSlot(currentEntryKey(), "catalog.category", "00000000-0000-4000-8000-00000000dead");
    const search = vi.fn(async () => []);
    await mount(search as never);
    expect(search).toHaveBeenCalled();
    expect((search.mock.calls.at(-1) as unknown as [{ categoryId: string }])[0].categoryId).toBe(ROOT);
    expect(screen.getByRole("button", { name: "Усі" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("сохранённый подраздел есть — применяется", async () => {
    writeSlot(currentEntryKey(), "catalog.category", SUB);
    const search = vi.fn(async () => []);
    await mount(search as never);
    expect((search.mock.calls.at(-1) as unknown as [{ categoryId: string }])[0].categoryId).toBe(SUB);
    expect(screen.getByRole("button", { name: "Кав'ярні" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Nearby: геолокация при возврате", () => {
  it("ушли, пока определялось: при возврате нет нового запроса, кнопка доступна", async () => {
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    window.history.replaceState(null, "", "#/nearby/me");
    const tree = (
      <I18nProvider locale="uk">
        <GuideProvider value={env(noopGuideApi())}>
          <Nearby useMyLocation />
        </GuideProvider>
      </I18nProvider>
    );
    const first = render(tree);
    await flush();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("nearby-locate") as HTMLButtonElement).disabled).toBe(true);

    window.location.hash = "#/place/x";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    first.unmount();
    const before = window.location.hash;
    window.history.back();
    await vi.waitFor(() => expect(window.location.hash).not.toBe(before));

    render(tree);
    await flush();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("nearby-locate") as HTMLButtonElement).disabled).toBe(false);
  });
});
