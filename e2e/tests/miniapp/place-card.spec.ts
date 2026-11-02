// Богатая картка місця на 360 px: галерея фото Google (через прокси api) с авторами, тип и рейтинг Google, текст ШІ
// с пометкой, «Що пропонує», отзывы, Вікіпедія с лицензией фото; полноэкранный просмотр; a11y. api и фото — моки.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { CAFE_PLACE, REGION_ID } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const API = "https://api.e2e.example";

const author = (name: string) => ({ name, uri: `https://maps.google.com/contrib/${name}`, photoUri: null });

function richCard() {
  const photo = (i: number) => ({
    url: `${API}/places/${CAFE_PLACE}/google-photos/${i}?regionId=${REGION_ID}&w=400`,
    largeUrl: `${API}/places/${CAFE_PLACE}/google-photos/${i}?regionId=${REGION_ID}&w=1200`,
    width: 1200,
    height: 800,
    authors: [author(i ? "Тарас" : "Олена")],
  });
  return {
    id: CAFE_PLACE,
    regionId: REGION_ID,
    categoryId: "00000000-0000-4000-8000-000000000102",
    category: {
      id: "00000000-0000-4000-8000-000000000102",
      parentId: null,
      name: { uk: "Ресторани" },
      icon: null,
    },
    name: { uk: "Wood Stone" },
    address: { uk: "вулиця Свободи, 59/3, Яремче" },
    location: { lon: 24.589416, lat: 48.4795574 },
    distanceMeters: null,
    recommended: false,
    adLabel: null,
    openNow: true,
    phone: "+380983001120",
    cover: null,
    description: { uk: "Ресторан у Яремчі. Джерело: Google Maps." },
    website: "https://woodstone.example/",
    telegram: null,
    verifiedAt: "2026-11-02T00:00:00Z",
    photos: [],
    tags: [],
    schedule: {
      timezone: "Europe/Kyiv",
      weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "10:00", closesAt: "22:00" })),
      exceptions: [],
    },
    openUntil: "22:00",
    favorite: null,
    typeLabel: "Ресторан",
    summary: null,
    aiSummary: {
      text: "Wood Stone — ресторан у Яремчі з терасою. Відвідувачі хвалять панорамний вид і привітне обслуговування.",
      model: "claude-sonnet-5-5",
      generatedAt: "2026-11-02T10:00:00Z",
    },
    priceLevel: 2,
    amenities: ["breakfast", "dinner", "coffee", "outdoor_seating", "kids_menu", "parking_free"],
    rating: { value: 4.8, count: 792, source: "google" },
    reviews: [
      {
        author: { name: "Іван", uri: null, photoUri: "https://lh3.googleusercontent.com/a/ivan" },
        rating: 5,
        text: "Неймовірний вид з тераси, смачна піца з печі.",
        language: "uk",
        publishTime: "2026-09-01T10:00:00Z",
        relativeTime: "2 місяці тому",
        uri: "https://www.google.com/maps/reviews/1",
      },
    ],
    googlePhotos: [photo(0), photo(1)],
    googleMapsUri: "https://maps.google.com/?cid=1",
    wikipedia: {
      lang: "uk",
      title: "Яремче",
      url: "https://uk.m.wikipedia.org/wiki/Яремче",
      extract: "Яремче — місто в Івано-Франківській області.",
      image: {
        url: "https://upload.wikimedia.org/wikipedia/commons/x.jpg",
        width: 1200,
        height: 800,
        author: "MSha",
        license: "CC BY-SA 3.0",
        licenseUrl: null,
        sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg",
      },
    },
  };
}

async function mockRichCard(page: Page) {
  const cors = { "access-control-allow-origin": "*" };
  // Позже зарегистрированный маршрут главнее мока каталога: карточка CAFE_PLACE — с данными Google.
  await page.route(
    (url) => url.pathname === `/places/${CAFE_PLACE}`,
    (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: cors })
        : route.fulfill({
            status: 200,
            headers: cors,
            contentType: "application/json",
            body: JSON.stringify(richCard()),
          }),
  );
  await page.route(/google-photos|googleusercontent\.com|upload\.wikimedia\.org/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
}

test.describe("богатая картка місця", () => {
  test.use({ telegram: { startParam: "demoHotel01" }, viewport: { width: 360, height: 780 } });

  test("галерея, тип и рейтинг Google, ШІ с пометкой, «Що пропонує», отзывы, Вікіпедія; a11y", async ({
    page,
  }) => {
    await page.route("**/health", (route) =>
      route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
    );
    await mockRichCard(page);
    await page.goto(`/#/place/${CAFE_PLACE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Wood Stone" })).toBeVisible();
    await expect(page.getByTestId("place-type")).toHaveText("Ресторан · Середні ціни");
    await expect(page.getByTestId("place-rating")).toContainText("792 оцінок у Google");
    await expect(page.getByTestId("place-ai-label")).toHaveText("Згенеровано ШІ");
    await expect(page.getByTestId("place-offers").getByRole("listitem")).toHaveCount(6);
    await expect(page.getByTestId("place-review")).toContainText("Іван");
    await expect(page.getByTestId("place-wikipedia")).toContainText("CC BY-SA 3.0");
    await expect(page.getByTestId("place-google-attribution")).toBeVisible();
    await expect(page.getByTestId("place-photos").getByRole("link", { name: "Олена" })).toBeVisible();
    // Ширина 360: без горизонтальной прокрутки страницы.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("button", { name: "Відкрити фото 1 з 2" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("img")).toHaveAttribute("src", /w=1200/);
    await expect(dialog).toContainText("Олена");
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
