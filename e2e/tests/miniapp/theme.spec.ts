// Тема «День» / «Ніч»: переключатель в меню, хранение в localStorage (tg.theme), первый кадр сразу в своей теме.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

test.use({ telegram: { startParam: "demoHotel01" } });
test.beforeEach(async ({ page }) => {
  apiMockState.get(page)!.consents = [
    { kind: "terms", version: "2026-11-01-draft" },
    { kind: "privacy", version: "2026-11-01-draft" },
  ];
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

const html = (page: Page) => page.locator("html");

async function openMenu(page: Page) {
  await page.getByTestId("menu-btn").click();
  return page.getByRole("dialog", { name: "Меню" });
}

test("по умолчанию «День», тема Telegram не наследуется", async ({ page }) => {
  await page.addInitScript(() => {
    // Тёмная тема системы и Telegram не должна включать «Ніч».
    (window as unknown as { Telegram: { WebApp: { colorScheme: string } } }).Telegram ??= {
      WebApp: { colorScheme: "dark" },
    };
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "day");
  const menu = await openMenu(page);
  const group = menu.getByRole("group", { name: "Тема оформлення" });
  await expect(group.getByRole("button")).toHaveText(["День", "Ніч"]);
  await expect(group.getByRole("button", { name: "День" })).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: "Ніч" })).toHaveAttribute("aria-pressed", "false");
  for (const b of await group.getByRole("button").all()) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test("выбор «Ніч»: лист закрывается, тема сохраняется после перезагрузки", async ({ page }) => {
  await page.goto("/");
  const menu = await openMenu(page);
  await menu.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "Ніч" }).click();
  await expect(page.getByRole("dialog", { name: "Меню" })).toHaveCount(0);
  await expect(html(page)).toHaveAttribute("data-theme", "night");
  expect(await page.evaluate(() => localStorage.getItem("tg.theme"))).toBe("night");
  await expectNoSeriousA11yViolations(page);
  await page.reload();
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "night");
  const menu2 = await openMenu(page);
  await expect(
    menu2.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "Ніч" }),
  ).toHaveAttribute("aria-pressed", "true");
  await menu2.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "День" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "day");
  expect(await page.evaluate(() => localStorage.getItem("tg.theme"))).toBe("day");
});

test("сохранённая «Ніч»: первый кадр не в чужой теме", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("tg.theme", "night");
    // Состояние на момент, когда документ разобран и бандл React ещё не отрисовал экран.
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { __firstFrame: string }).__firstFrame =
        `${document.documentElement.getAttribute("data-theme")}|${getComputedStyle(document.body).backgroundColor}`;
    });
  });
  await page.goto("/");
  const first = await page.evaluate(() => (window as unknown as { __firstFrame: string }).__firstFrame);
  expect(first).toBe("night|rgb(9, 25, 19)");
});

test("повреждённое значение — «День»", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tg.theme", '{"theme":"purple"}'));
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expect(html(page)).toHaveAttribute("data-theme", "day");
});

test("хранилище недоступно: «День», выбор действует до перезагрузки", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k: string) {
      if (k === "tg.theme") throw new Error("denied");
      return get.call(this, k);
    };
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === "tg.theme") throw new Error("denied");
      return set.call(this, k, v);
    };
  });
  await page.goto("/");
  await expect(html(page)).toHaveAttribute("data-theme", "day");
  const menu = await openMenu(page);
  await menu.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "Ніч" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "night");
  await page.reload();
  await expect(html(page)).toHaveAttribute("data-theme", "day");
});

test("«Ніч»: контраст на главной, «Що поруч», списке и избранном", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto("/#/nearby");
  await expect(page.getByTestId("places-map")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.getByTestId("place-item").first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto("/#/favorites");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
