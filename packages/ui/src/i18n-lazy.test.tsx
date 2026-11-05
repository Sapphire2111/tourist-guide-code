// Ленивая загрузка en в I18nProvider (без предзагрузки "@tg/i18n/en"): до загрузки — uk, после — en;
// размонтирование во время загрузки и сбой загрузки не ломают дерево.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as I18n from "@tg/i18n";
import type { Locale } from "@tg/i18n";
import { I18nProvider, useT } from "./index.js";

const ctl = vi.hoisted(() => ({ impl: null as null | ((l: Locale) => Promise<void>) }));
vi.mock("@tg/i18n", async (orig) => {
  const actual = await orig<typeof I18n>();
  return {
    ...actual,
    loadLocale: (l: Locale) => (ctl.impl ? ctl.impl(l) : actual.loadLocale(l)),
  };
});

afterEach(() => {
  cleanup();
  ctl.impl = null;
});

function Probe() {
  const { t } = useT();
  return <p data-testid="probe">{t("common.weekday.1")}</p>;
}

const show = () =>
  render(
    <I18nProvider locale="en">
      <Probe />
    </I18nProvider>,
  );

describe("I18nProvider: ленивый en", () => {
  it("сбой загрузки — остаётся uk, без сырых ключей", async () => {
    ctl.impl = () => Promise.reject(new Error("offline"));
    show();
    await act(async () => {});
    expect(screen.getByTestId("probe").textContent).toBe("Понеділок");
  });

  it("размонтирование во время загрузки — без ошибок", async () => {
    let resolve!: () => void;
    ctl.impl = () => new Promise<void>((r) => (resolve = r));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = show();
    unmount();
    await act(async () => resolve());
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("uk до загрузки → en после", async () => {
    show();
    expect(screen.getByTestId("probe").textContent).toBe("Понеділок");
    expect(await screen.findByText("Monday")).toBeDefined();
  });
});
