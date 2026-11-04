// «Де жити»: фильтр удобств — кнопка «Зручності», нижний лист с флажками и счётчиками, выдача только со всеми
// отмеченными (tags), «Скинути», закрытие; цели касания ≥ 44 px, тема «Ніч», a11y. Каталог «Де жити» и счётчики —
// свои маршруты поверх support/api-mock.ts (там раздела stay нет).
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { expect, test } from "../../support/fixtures.js";

const STAY = "00000000-0000-4000-8000-000000000301";
const HOTELS = "00000000-0000-4000-8000-000000000302";
const cors = { "access-control-allow-origin": "*" };

const stayPlace = (n: number, tags: string[]) => ({
  id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
  categoryId: HOTELS,
  name: { uk: `Садиба ${n}` },
  address: { uk: "м. Тестове" },
  location: { lat: 48.45 + n / 1000, lon: 24.56 },
  distanceMeters: null,
  recommended: false,
  adLabel: null,
  openNow: null,
  phone: null,
  cover: null,
  tags,
});
const PLACES = [
  stayPlace(1, ["pool", "sauna"]),
  stayPlace(2, ["pool"]),
  stayPlace(3, ["sauna", "hot-tub"]),
  stayPlace(4, []),
];

async function stayCatalog(page: Page) {
  const searches: string[][] = [];
  await page.route(
    (url) => url.pathname === "/categories",
    (route) =>
      route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.fulfill({
            headers: cors,
            json: {
              items: [
                {
                  id: STAY,
                  parentId: null,
                  code: "stay",
                  name: { uk: "Де жити" },
                  icon: null,
                  homeSection: "stay",
                  sortOrder: 0,
                  placeCount: 4,
                },
                {
                  id: HOTELS,
                  parentId: STAY,
                  code: "hotels",
                  name: { uk: "Готелі" },
                  icon: null,
                  homeSection: null,
                  sortOrder: 1,
                  placeCount: 4,
                },
              ],
            },
          }),
  );
  await page.route(
    (url) => url.pathname === "/places/search",
    (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      const url = new URL(route.request().url());
      const tags = url.searchParams.getAll("tags").flatMap((v) => v.split(","));
      searches.push(tags);
      const items = PLACES.filter((p) => tags.every((t) => p.tags.includes(t))).map(
        ({ tags: _t, ...p }) => p,
      );
      return route.fulfill({ headers: cors, json: { items, nextOffset: null, radiusMeters: null } });
    },
  );
  await page.route(
    (url) => url.pathname === "/places/tag-counts",
    (route) =>
      route.request().method() === "OPTIONS"
        ? route.fallback()
        : route.fulfill({
            headers: cors,
            json: {
              items: [
                { code: "pool", name: { uk: "Басейн" }, count: 2 },
                { code: "sauna", name: { uk: "Сауна / баня" }, count: 2 },
                { code: "hot-tub", name: { uk: "Чан / джакузі" }, count: 1 },
              ],
            },
          }),
  );
  return searches;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" }, headers: cors }));
});

test.describe("QR отеля demoHotel01", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("лист «Зручності»: флажки со счётчиками, И-фильтр, «Скинути», 44 px; a11y", async ({ page }) => {
    const searches = await stayCatalog(page);
    await page.goto("/#/section/stay");
    await page.getByRole("button", { name: "Список" }).click();
    const list = page.getByTestId("place-list");
    await expect(list.getByRole("link")).toHaveCount(4);

    const trigger = page.getByTestId("amenity-filter");
    await expect(trigger).toHaveText(/Зручності/);
    expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Зручності" });
    await expect(sheet).toBeVisible();
    // Только удобства с местами, со счётчиком.
    await expect(sheet.getByRole("checkbox")).toHaveCount(3);
    await expect(sheet.getByLabel("місць: 2").first()).toHaveText("2");
    for (const row of await sheet.locator(".loc-option").all())
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoSeriousA11yViolations(page);

    await sheet.getByRole("checkbox", { name: /Басейн/ }).check();
    await expect(list.getByRole("link")).toHaveCount(2);
    await sheet.getByRole("checkbox", { name: /Сауна/ }).check();
    await expect(list.getByRole("link")).toHaveCount(1);
    await expect(list.getByRole("link", { name: "Садиба 1" })).toBeVisible();
    expect(searches.at(-1)).toEqual(["pool", "sauna"]);

    await sheet.getByRole("button", { name: "Готово" }).click();
    await expect(sheet).toBeHidden();
    await expect(trigger).toHaveText(/Зручності · 2/);

    // Escape закрывает, «Скинути» снимает все отметки.
    await trigger.click();
    await page.getByRole("dialog").getByRole("button", { name: "Скинути" }).click();
    await expect(list.getByRole("link")).toHaveCount(4);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toHaveText(/^Зручності/);
    await expect(trigger).not.toHaveText(/·/);
  });

  test("тема «Ніч»: лист читается (токены темы), без серьёзных нарушений a11y", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
    await stayCatalog(page);
    await page.goto("/#/section/stay");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
    await page.getByTestId("amenity-filter").click();
    const sheet = page.getByRole("dialog", { name: "Зручності" });
    await expect(sheet).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
