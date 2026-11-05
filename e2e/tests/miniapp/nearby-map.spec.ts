// «Що поруч»: окно маркера (фото, «Маршрут», карточка) и компактная капсула радиуса. Карта — фейк API (support/google-maps-fake.ts).
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { animationsDone } from "../../support/animations.js";
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
  // Холодная загрузка под нагрузкой (медленный CPU на CI) дольше 5 с: это ожидание, а не допуск замера.
  await expect(page.getByTestId("places-map")).toBeVisible({ timeout: 15_000 });
  await animationsDone(page);
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
    await page.getByTestId("nearby-filter").click();
    await page.getByRole("dialog").getByRole("radio", { name: "Шукати все" }).click();
    await page.getByRole("slider", { name: "Радіус пошуку" }).fill("4");
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

test.describe("окно маркера: фокус и размер карты", () => {
  test("× первая в Tab, кольца контрастны, закрытие возвращает фокус на маркер", async ({ page }) => {
    await mockPlace(page, { coverPhoto: googleCover });
    const popup = await openPopup(page);
    const info = page.locator(".gm-fake-info");
    await expect(info).toHaveAttribute("aria-label", "Кав'ярня «Смерека»");
    await expect(info).toHaveAttribute("data-should-focus", "true");
    const close = popup.getByRole("button", { name: "Закрити" });
    // × — первая по порядку фокуса, но видна поверх фото.
    expect(await popup.locator("a, button").first().getAttribute("aria-label")).toBe("Закрити");
    const box = (await close.boundingBox())!;
    const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    expect(top).toBe("kosiv-map-popup-close");
    await close.focus();
    const ring = (sel: string) =>
      popup.locator(sel).evaluate((n) => {
        const s = getComputedStyle(n);
        return { color: s.outlineColor, offset: parseFloat(s.outlineOffset), style: s.outlineStyle };
      });
    // С клавиатуры: Tab вперёд — подпись/действия, Shift+Tab — обратно на × (кольцо :focus-visible).
    await page.keyboard.press("Tab");
    await expect(popup.locator("a.kosiv-map-popup-route")).toBeFocused();
    const routeRing = await ring("a.kosiv-map-popup-route");
    expect(routeRing.style).toBe("solid");
    expect(routeRing.color).toBe("rgb(29, 78, 216)");
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    const closeRing = await ring(".kosiv-map-popup-close");
    expect(closeRing.color).toBe("rgb(255, 255, 255)");
    expect(closeRing.offset).toBeLessThan(0);
    await close.click();
    await expect(popup).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("gm-fake-marker");
  });

  test("«Список ↓» закрывает окно: оно не уходит за панель, кнопки масштаба возвращаются", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await mockPlace(page, { coverPhoto: googleCover });
    const popup = await openPopup(page);
    const map = page.locator(".gm-fake-map");
    await expect(map).toHaveAttribute("data-zoom-control", "false");
    await page.getByRole("button", { name: "Список ↓" }).click();
    await expect(popup).toHaveCount(0);
    await expect(map).toHaveAttribute("data-zoom-control", "true");
    await expect(map).toHaveAttribute("data-fit-height", "306");
  });
});

test.describe("кнопки «Маршрут» вне окна маркера: Google Карты", () => {
  const telegramOpenLink = (page: Page) =>
    page.addInitScript(() => {
      const w = window as unknown as {
        Telegram: { WebApp: { openLink?: (u: string) => void } };
        __opened: string[];
      };
      w.__opened = [];
      w.Telegram.WebApp.openLink = (u) => w.__opened.push(u);
    });
  const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  const routeEvents = (page: Page) =>
    apiMockState.get(page)!.events.filter((e) => e.event === "route_clicked");

  test("список «Поруч»: ссылка Google, openLink в Telegram, аналитика; OSM на экране нет", async ({
    page,
  }) => {
    await telegramOpenLink(page);
    await mockPlace(page);
    await page.goto("/#/nearby");
    const route = page.getByTestId("place-item").first().getByRole("link", { name: "Маршрут", exact: true });
    await expect(route).toHaveAttribute("href", ROUTE);
    await expect(page.locator('a[href*="openstreetmap"]')).toHaveCount(0);
    await route.click();
    expect(await opened(page)).toEqual([ROUTE]);
    await expect.poll(() => routeEvents(page).length).toBe(1);
  });

  test("карточка места: ссылка Google, openLink в Telegram, аналитика", async ({ page }) => {
    await telegramOpenLink(page);
    await page.goto(`/#/place/${CAFE_PLACE}`);
    const route = page.getByTestId("place-route");
    await expect(route).toHaveAttribute("href", ROUTE);
    await route.click();
    expect(await opened(page)).toEqual([ROUTE]);
    await expect.poll(() => routeEvents(page).length).toBe(1);
  });
});

test.describe("радиус «Лінійка-барабан»", () => {
  for (const width of [320, 390] as const) {
    for (const night of [false, true]) {
      test(`${width} px${night ? " «Ніч»" : ""}: компактная капсула по центру, 1 км в рамке, лента 44 px без наезда на чипы`, async ({
        page,
      }) => {
        if (night) await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/#/nearby");
        await expect(page.getByTestId("places-map")).toBeVisible();
        await animationsDone(page);
        const slider = page.getByRole("slider", { name: "Радіус пошуку" });
        await expect(slider).toHaveAttribute("aria-valuetext", "1 км");
        await expect(page.getByTestId("radius-slider-value")).toHaveText("1 км");
        const capsule = (await page.locator(".kosiv-radius-overlay .kosiv-rd").boundingBox())!;
        expect(Math.round(capsule.height)).toBe(44);
        expect(capsule.width).toBeLessThanOrEqual(256);
        // Выбранное значение — ровно в центре капсулы, в рамке.
        const value = (await page.getByTestId("radius-slider-value").boundingBox())!;
        const frame = (await page.locator(".kosiv-rd-frame").boundingBox())!;
        const mid = capsule.x + capsule.width / 2;
        expect(Math.abs(value.x + value.width / 2 - mid)).toBeLessThanOrEqual(1);
        expect(Math.abs(frame.x + frame.width / 2 - mid)).toBeLessThanOrEqual(1);
        // Капсула по центру окна карты.
        const map = (await page.getByTestId("places-map").boundingBox())!;
        expect(Math.abs(mid - (map.x + map.width / 2))).toBeLessThanOrEqual(1);
        const strip = (await page.locator(".kosiv-rd-strip").boundingBox())!;
        expect(Math.round(strip.height)).toBeGreaterThanOrEqual(44);
        const chip = await page.evaluate(() => {
          const c = document.querySelector(".modern-filters button")!;
          return c.getBoundingClientRect().top + parseFloat(getComputedStyle(c, "::after").top);
        });
        expect(strip.y + strip.height).toBeLessThanOrEqual(chip);
        // Панель над картой: отступ 8 + капсула 44 + 2 + ряд чипов 44 — не больше 98 px от верха окна карты.
        const panel = (await page.locator('[data-map-inset="top"]').boundingBox())!;
        expect(panel.y + panel.height - map.y).toBeLessThanOrEqual(98);
        await expectNoSeriousA11yViolations(page);
      });
    }
  }

  test("нажатие на значение, свайп ленты и клавиатура меняют радиус; запрос — когда лента остановилась", async ({
    page,
  }) => {
    const state = apiMockState.get(page)!;
    await page.goto("/#/nearby");
    await expect(page.getByTestId("places-map")).toBeVisible();
    await animationsDone(page);
    const strip = page.locator(".kosiv-rd-strip");
    // Нажатие на видимое соседнее значение.
    await strip.getByText("2 км", { exact: true }).click();
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 2 км");
    await expect.poll(() => state.searches.at(-1)?.radius).toBe("2000");
    // Свайп: лента доезжает до 10 км (шаг 6 × 56 px) — значение в рамке, потом один запрос.
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(3 * 56);
    const count = state.searches.length;
    await strip.evaluate((el) => {
      for (const left of [200, 260, 300, 6 * 56]) {
        el.scrollLeft = left;
        el.dispatchEvent(new Event("scroll"));
      }
    });
    await expect(page.getByTestId("radius-slider-value")).toHaveText("10 км");
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 10 км");
    await expect.poll(() => state.searches.at(-1)?.radius).toBe("10000");
    expect(state.searches.length).toBe(count + 1);
    // Клавиатура: фокус на скрытом ползунке — рамка фокуса у капсулы; End — 20 км, Home — 300 м.
    const slider = page.getByRole("slider", { name: "Радіус пошуку" });
    await slider.focus();
    await page.keyboard.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", "20 км");
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(8 * 56);
    await page.keyboard.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", "300 м");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 500 м");
    await expect(page.locator(".kosiv-rd")).not.toHaveCSS("outline-style", "none");
  });
});
