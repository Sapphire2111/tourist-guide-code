// «Що поруч»: окно маркера (фото, «Маршрут», карточка) и компактная капсула радиуса. Карта — фейк API (support/google-maps-fake.ts).
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
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

// Не /places/…: этот путь перехватывает мок api (сопоставляет по пути на любом хосте).
const COVER = "https://cdn.example/photos/cafe.webp";
const ROUTE = "https://www.google.com/maps/dir/?api=1&destination=48.4512,24.5612";

/** Одно место в выдаче: с нужной обложкой и подписью. */
async function mockPlace(page: Page, over: Record<string, unknown> = {}) {
  await page.route("**/places/search?**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        items: [
          {
            id: CAFE_PLACE,
            categoryId: CAFE_PLACE,
            name: { uk: "Кав'ярня «Смерека»" },
            address: null,
            location: { lon: 24.5612, lat: 48.4512 },
            distanceMeters: 160,
            recommended: false,
            adLabel: null,
            openNow: null,
            phone: null,
            cover: null,
            coverPhoto: null,
            ...over,
          },
        ],
        nextOffset: null,
        radiusMeters: 1000,
      },
    }),
  );
}

async function openPopup(page: Page) {
  await page.goto("/#/nearby");
  await page.getByTestId("places-map").locator(".kosiv-pin[data-distance]").first().click();
  const popup = page.locator(".kosiv-map-popup");
  await expect(popup).toBeVisible();
  return popup;
}

const googleCover = {
  url: COVER,
  source: "google",
  authors: [{ name: "Автор Фото", uri: null, photoUri: null }],
  license: null,
  sourceUrl: null,
};

test.describe("окно маркера", () => {
  test("«Маршрут» в браузере: ссылка Google Карт в новой вкладке, аналитика; цели не меньше 44 px", async ({
    page,
    context,
  }) => {
    await context.route("**/www.google.com/maps/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "ok" }),
    );
    await mockPlace(page);
    const popup = await openPopup(page);
    const route = popup.getByRole("link", { name: "Маршрут: Кав'ярня «Смерека»" });
    await expect(route).toHaveText("Маршрут");
    await expect(route).toHaveAttribute("href", ROUTE);
    await expect(route).toHaveAttribute("target", "_blank");
    for (const target of [route, popup.getByRole("link", { name: "Відкрити картку" })]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const close = (await popup.getByRole("button", { name: "Закрити" }).boundingBox())!;
    expect(close.height).toBeGreaterThanOrEqual(44);
    expect(close.width).toBeGreaterThanOrEqual(44);
    const [tab] = await Promise.all([context.waitForEvent("page"), route.click()]);
    expect(tab.url()).toBe(ROUTE);
    const state = apiMockState.get(page)!;
    await expect.poll(() => state.events.map((e) => e.event)).toContain("route_clicked");
  });

  test("«Маршрут» в Telegram: через openLink, без новой вкладки", async ({ page, context }) => {
    await page.addInitScript(() => {
      const w = window as unknown as {
        Telegram: { WebApp: { openLink?: (u: string) => void } };
        __opened: string[];
      };
      w.__opened = [];
      w.Telegram.WebApp.openLink = (u) => w.__opened.push(u);
    });
    await mockPlace(page);
    const popup = await openPopup(page);
    const pages = context.pages().length;
    await popup.getByRole("link", { name: "Маршрут: Кав'ярня «Смерека»" }).click();
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([
      ROUTE,
    ]);
    expect(context.pages().length).toBe(pages);
  });

  test("«Відкрити картку» открывает карточку места", async ({ page }) => {
    const popup = await openPopup(page);
    await popup.getByRole("link", { name: "Відкрити картку" }).click();
    await expect(page).toHaveURL(new RegExp(`#/place/${CAFE_PLACE}|#/place/`));
    await expect(page.getByTestId("places-map")).toHaveCount(0);
  });

  test("с обложкой: фото во всю ширину, подпись автора, закрытие поверх фото; без заголовка Google", async ({
    page,
  }) => {
    await mockPlace(page, { coverPhoto: googleCover });
    const popup = await openPopup(page);
    await expect(page.locator(".gm-fake-info")).toHaveAttribute("data-header-disabled", "true");
    const img = popup.getByRole("img", { name: "Фото: Кав'ярня «Смерека»" });
    await expect(img).toHaveAttribute("src", COVER);
    await expect(img).toHaveAttribute("loading", "lazy");
    const box = (await popup.boundingBox())!;
    const pic = (await img.boundingBox())!;
    expect(pic.width).toBe(box.width);
    expect(pic.y).toBe(box.y);
    expect(pic.height).toBe(84);
    await expect(popup.getByTestId("cover-credit")).toContainText("Автор Фото");
    await expect(popup.locator(".kosiv-map-popup-icon")).toHaveCount(0);
    await expect(popup).toContainText("160 м");
    const close = (await popup.getByRole("button", { name: "Закрити" }).boundingBox())!;
    expect(close.y).toBeLessThan(pic.y + pic.height);
    await expectNoSeriousA11yViolations(page);
    await popup.getByRole("button", { name: "Закрити" }).click();
    await expect(popup).toHaveCount(0);
  });

  test("обложка Wikimedia: подпись с лицензией — ссылка на страницу файла", async ({ page }) => {
    await mockPlace(page, {
      coverPhoto: {
        url: COVER,
        source: "wikimedia",
        authors: [{ name: "Commons Author", uri: null, photoUri: null }],
        license: "CC BY-SA 4.0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Smereka.jpg",
      },
    });
    const popup = await openPopup(page);
    const credit = popup.getByTestId("cover-credit").getByRole("link");
    await expect(credit).toContainText("Commons Author");
    await expect(credit).toContainText("CC BY-SA 4.0");
    await expect(credit).toHaveAttribute("href", "https://commons.wikimedia.org/wiki/File:Smereka.jpg");
  });

  test("без обложки: компактный вид со значком, серого прямоугольника нет", async ({ page }) => {
    await mockPlace(page);
    const popup = await openPopup(page);
    await expect(popup).toHaveAttribute("data-cover", "none");
    await expect(popup.locator("img")).toHaveCount(0);
    await expect(popup.locator(".kosiv-map-popup-media")).toHaveCount(0);
    await expect(popup.locator(".kosiv-map-popup-icon")).toBeVisible();
    expect((await popup.boundingBox())!.height).toBeLessThan(130);
    await expectNoSeriousA11yViolations(page);
  });

  test("обложка не загрузилась: компактный вид, подпись автора убрана", async ({ page }) => {
    await page.route(/cover-broken/, (route) => route.fulfill({ status: 404, body: "" }));
    await mockPlace(page, { coverPhoto: { ...googleCover, url: "https://cdn.test/cover-broken.webp" } });
    const popup = await openPopup(page);
    await expect(popup).toHaveAttribute("data-cover", "none");
    await expect(popup.locator("img")).toHaveCount(0);
    await expect(popup.getByTestId("cover-credit")).toHaveCount(0);
    await expect(popup.locator(".kosiv-map-popup-icon")).toBeVisible();
  });

  test("другой маркер: окно одно, с новым местом; смена категории закрывает окно", async ({ page }) => {
    await page.goto("/#/nearby");
    const pins = page.getByTestId("places-map").locator(".kosiv-pin[data-distance]");
    await pins.nth(0).click();
    const popup = page.locator(".kosiv-map-popup");
    const first = await popup.locator("strong").textContent();
    // Первое окно закрывает собой маркеры фейка: второй нажимается событием, как нажатие на настоящей карте.
    await page.locator('.gm-fake-marker[role="button"]').nth(1).dispatchEvent("click");
    await expect(popup).toHaveCount(1);
    await expect(popup.locator("strong")).not.toHaveText(first!);
    await page
      .getByRole("group", { name: "Категорії місць поруч" })
      .getByRole("button", { name: "Усі поруч" })
      .click();
    await page.getByRole("group", { name: "Радіус" }).getByRole("button", { name: "3 км" }).click();
    await expect(popup).toHaveCount(0);
  });

  for (const [width, height] of [
    [320, 568],
    [320, 740],
    [390, 844],
  ] as const) {
    for (const night of [false, true]) {
      test(`${width}×${height}${night ? " «Ніч»" : ""}: окно с фото не уходит под панель и за края карты`, async ({
        page,
      }) => {
        if (night) await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
        await page.setViewportSize({ width, height });
        await mockPlace(page, { coverPhoto: googleCover });
        const popup = await openPopup(page);
        await expect(page.locator(".gm-fake-map")).toHaveAttribute("data-pan-count", "1");
        const panel = (await page.locator('[data-map-inset="top"]').boundingBox())!;
        const map = (await page.getByTestId("places-map").boundingBox())!;
        await expect(async () => {
          const box = (await popup.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual(panel.y + panel.height);
          expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);
          expect(box.x).toBeGreaterThanOrEqual(map.x);
          expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width);
        }).toPass();
        await expect(popup.getByRole("img")).toBeVisible();
        // Кнопки масштаба выше окна: окно левее них, а если места нет — кнопки скрыты, пока окно открыто.
        const fake = page.locator(".gm-fake-map");
        if (width === 390) {
          await expect(fake).toHaveAttribute("data-zoom-control", "true");
          const box = (await popup.boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width - 58);
        } else await expect(fake).toHaveAttribute("data-zoom-control", "false");
        await popup.getByRole("button", { name: "Закрити" }).click();
        await expect(fake).toHaveAttribute("data-zoom-control", "true");
      });
    }
  }
});

test.describe("капсула радиуса", () => {
  for (const width of [320, 390] as const) {
    for (const night of [false, true]) {
      test(`${width} px${night ? " «Ніч»" : ""}: капсула 34 px по содержимому, цели 44 px без наезда на чипы`, async ({
        page,
      }) => {
        if (night) await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/#/nearby");
        await expect(page.getByTestId("places-map")).toBeVisible();
        const radius = page.getByRole("group", { name: "Радіус" });
        await expect(radius.getByRole("button")).toHaveText([
          "300 м",
          "500 м",
          "1 км",
          "3 км",
          "5 км",
          "10 км",
        ]);
        const track = (await page.locator(".modern-radius-track").boundingBox())!;
        expect(Math.round(track.height)).toBeLessThanOrEqual(34);
        expect(Math.round(track.height)).toBeGreaterThanOrEqual(32);
        const font = await radius
          .getByRole("button")
          .first()
          .evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
        expect(font).toBeGreaterThanOrEqual(12);
        // По содержимому: на 390 px капсула не тянется на весь ряд.
        const panel = (await page.locator('[data-map-inset="top"]').boundingBox())!;
        if (width === 390) expect(track.width).toBeLessThan(panel.width);
        // Цели: кнопка + псевдоэлемент = 44 px; нижний край цели радиуса не заходит на цель чипа.
        // Замер одним вызовом: экран ещё может доезжать анимацией появления.
        const { reach, chip } = await page.evaluate(() => {
          const pill = document.querySelector(".modern-radius button")!;
          const r = pill.getBoundingClientRect();
          const a = getComputedStyle(pill, "::after");
          const c = document.querySelector(".modern-filters button")!;
          return {
            reach: { top: r.top + parseFloat(a.top), bottom: r.bottom - parseFloat(a.bottom) },
            chip: c.getBoundingClientRect().top + parseFloat(getComputedStyle(c, "::after").top),
          };
        });
        expect(reach.bottom - reach.top).toBeGreaterThanOrEqual(44);
        expect(reach.bottom).toBeLessThanOrEqual(chip);
        // Точка в расширении цели (над видимой пилюлей) попадает в кнопку, а карта вне капсулы не перекрыта.
        const box = (await radius.getByRole("button", { name: "300 м" }).boundingBox())!;
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, {
          x: box.x + box.width / 2,
          y: box.y - 4,
        });
        expect(hit).toBe("300 м");
        // Панель над картой: не больше 92 px от верха окна карты.
        const map = (await page.getByTestId("places-map").boundingBox())!;
        expect(panel.y + panel.height - map.y).toBeLessThanOrEqual(92);
        await expectNoSeriousA11yViolations(page);
      });
    }
  }

  test("320 px: ряд прокручивается к активной, край показывает, что есть ещё", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/#/nearby");
    await expect(page.getByTestId("places-map")).toBeVisible();
    const radius = page.getByRole("group", { name: "Радіус" });
    await page.evaluate(() => document.fonts.ready);
    // Значения не помещаются — виден признак «есть ещё» справа. Активная 1 км видна без прокрутки.
    await expect(radius).toHaveAttribute("data-more", "end");
    expect(await radius.evaluate((n) => n.scrollLeft)).toBe(0);
    expect(await radius.evaluate((n) => getComputedStyle(n).maskImage)).toContain("linear-gradient");
    const pill = radius.getByRole("button", { name: "10 км" });
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
    await expect(radius).toHaveAttribute("data-more", "start");
    const view = (await radius.boundingBox())!;
    const active = (await pill.boundingBox())!;
    expect(active.x).toBeGreaterThanOrEqual(view.x);
    expect(active.x + active.width).toBeLessThanOrEqual(view.x + view.width + 1);
    await radius.getByRole("button", { name: "300 м" }).click();
    await expect(radius).toHaveAttribute("data-more", "end");
  });
});
