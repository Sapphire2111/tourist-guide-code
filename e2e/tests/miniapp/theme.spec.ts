// Тема «День» / «Ніч»: переключатель в меню, хранение в localStorage (tg.theme), первый кадр сразу в своей теме.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { installAssistantMock } from "../../support/assistant-mock.js";
import { bookingDto, installBookingsMock, PARTNER_PLACE } from "../../support/bookings-mock.js";
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
  await page.getByRole("button", { name: "Список ↓" }).click();
  await expect(page.getByTestId("place-item").first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto("/#/favorites");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

// ---- Карта и оформление «Поруч» при смене темы, размера и на низком экране ----

function channels(color: string): [number, number, number] {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(color);
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}
function contrastOf(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = channels(c).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("смена темы на открытом «Поруч»: карта получает тёмную схему, маркеры и подпись читаемы", async ({
  page,
}) => {
  await page.goto("/#/nearby");
  const map = page.locator(".gm-fake-map");
  await expect(map).toHaveAttribute("data-color-scheme", "LIGHT");
  const markers = page.locator(".gm-fake-marker");
  await expect(markers.first()).toBeAttached();
  const count = await markers.count();
  await expect(page.getByTestId("places-map")).toHaveCSS("background-color", "rgb(229, 227, 223)");
  const menu = await openMenu(page);
  await menu.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "Ніч" }).click();
  await expect(html(page)).toHaveAttribute("data-theme", "night");
  // Старая светлая карта ушла в пул, на экране одна — тёмная, со всеми маркерами.
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute("data-color-scheme", "DARK");
  await expect(markers).toHaveCount(count);
  await expect(page.getByTestId("places-map")).toHaveCSS("background-color", "rgb(14, 35, 27)");
  // Подпись маркера на белом InfoWindow: название, категория и ссылка — не светлые на белом.
  await page.locator('.gm-fake-marker[role="button"]').first().click();
  const popup = page.locator(".kosiv-map-popup");
  await expect(popup).toBeVisible();
  for (const sel of ["strong", "span", "a"]) {
    const color = await popup
      .locator(sel)
      .first()
      .evaluate((n) => getComputedStyle(n).color);
    expect(contrastOf(color, "rgb(255, 255, 255)"), sel).toBeGreaterThanOrEqual(4.5);
  }
  // Обратно в «День» — снова светлая схема.
  const menu2 = await openMenu(page);
  await menu2.getByRole("group", { name: "Тема оформлення" }).getByRole("button", { name: "День" }).click();
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute("data-color-scheme", "LIGHT");
});

test("«Список ↓» / «Розгорнути»: карта получает новый размер и границы подгоняются заново", async ({
  page,
}) => {
  await page.goto("/#/nearby");
  const map = page.locator(".gm-fake-map");
  await expect(map).toHaveAttribute("data-fit-count", /^[1-9]/);
  await expect(map).toHaveAttribute("data-fit-height", "461");
  const fits = Number(await map.getAttribute("data-fit-count"));
  const resizes = Number(await map.getAttribute("data-resize-count"));
  await page.getByRole("button", { name: "Список ↓" }).click();
  await expect(map).toHaveAttribute("data-fit-height", "306");
  expect(Number(await map.getAttribute("data-fit-count"))).toBeGreaterThan(fits);
  expect(Number(await map.getAttribute("data-resize-count"))).toBeGreaterThan(resizes);
  await page.getByRole("button", { name: "Розгорнути" }).click();
  await expect(map).toHaveAttribute("data-fit-height", "461");
});

for (const [width, height, mapHeight] of [
  [390, 844, 461],
  [320, 740, 461],
  [320, 568, 412],
] as const) {
  test(`«Поруч» ${width}×${height}: окно карты ${mapHeight} px, плашка над навигацией`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/#/nearby");
    await expect(page.getByTestId("places-map")).toBeVisible();
    await expect(page.locator(".modern-map-spot")).toBeVisible();
    const box = (await page.getByTestId("places-map").boundingBox())!;
    expect(Math.round(box.height)).toBe(mapHeight);
    const spot = (await page.locator(".modern-map-spot").boundingBox())!;
    const nav = (await page.locator(".kosiv-nav").boundingBox())!;
    expect(spot.y + spot.height).toBeLessThanOrEqual(nav.y);
  });
}

test("цели нажатия: чипы категорий, пилюли радиуса и теги героя не меньше 44 px", async ({ page }) => {
  // Видимый размер не меняется: недостающее даёт ::after (inset < 0).
  const reach = (selector: string) =>
    page.locator(selector).evaluateAll((nodes) =>
      nodes.map((n) => {
        const h = n.getBoundingClientRect().height;
        const after = getComputedStyle(n, "::after");
        const extra = after.content === "none" ? 0 : -parseFloat(after.top) - parseFloat(after.bottom);
        return { h, total: Math.max(h, h + extra) };
      }),
    );
  await page.goto("/#/nearby");
  await expect(page.locator(".modern-filters button").first()).toBeVisible();
  for (const sel of [".modern-filters button", ".modern-radius button"]) {
    const items = await reach(sel);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.total, sel).toBeGreaterThanOrEqual(44);
  }
  const chip = await reach(".modern-filters button");
  expect(chip[0]!.h).toBe(34);
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  const tags = await reach(".modern-hero-glass .kosiv-tag");
  if (tags.length) {
    for (const i of tags) expect(i.total).toBeGreaterThanOrEqual(44);
  }
});

test("лист меню: кольцо фокуса не жёлтое (на светлом листе), на полосе — жёлтое", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const a = document.activeElement!;
      return a.closest('[data-testid="app-top"]') ? getComputedStyle(a).outlineColor : "outside";
    }),
  ).toBe("rgb(253, 230, 138)");
  await page.getByTestId("menu-btn").click();
  await expect(page.getByRole("dialog", { name: "Меню" })).toBeVisible();
  await page.keyboard.press("Tab");
  const inSheet = await page.evaluate(() => {
    const a = document.activeElement!;
    return {
      inside: Boolean(a.closest('[data-testid="app-settings"]')),
      outline: getComputedStyle(a).outlineColor,
    };
  });
  expect(inSheet.inside).toBe(true);
  expect(inSheet.outline).not.toBe("rgb(253, 230, 138)");
});

test("«Поруч» без геолокации: сортировка «від <база>», а не «від вас»", async ({ page }) => {
  await page.goto("/#/nearby");
  await expect(page.locator(".modern-results-kicker")).toHaveText(/За відстанню від Тестовий готель/);
  await expect(page.locator(".modern-results-kicker")).not.toContainText("від вас");
});

test("пустая live-область голоса на главной остаётся в дереве доступности", async ({ page }) => {
  await page.goto("/");
  const status = page.getByTestId("assistant-voice-status");
  await expect(status).toBeAttached();
  await expect(status).toHaveCSS("display", "block");
});

test("карта не загрузилась: плашка с ближайшим местом остаётся над заглушкой", async ({ page }) => {
  await page.addInitScript(() => {
    const g = (window as unknown as { google: { maps: { importLibrary: () => Promise<never> } } }).google;
    g.maps.importLibrary = () => Promise.reject(new Error("net"));
  });
  await page.goto("/#/nearby");
  await expect(page.getByRole("alert").filter({ hasText: "Карту не вдалося завантажити" })).toBeVisible();
  await expect(page.locator(".modern-map-spot")).toBeVisible();
});

test("«Ніч»: контраст на «Про заклад» и ассистенте", async ({ page }) => {
  await installAssistantMock(page);
  await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
  const screens: [string, string][] = [
    [`/#/assistant?q=${encodeURIComponent("Де поїсти суші")}`, "Асистент"],
    ["/#/about", "Правила проживання"],
  ];
  for (const [path, heading] of screens) {
    await page.goto(path);
    await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
    await expect(html(page)).toHaveAttribute("data-theme", "night");
    await expectNoSeriousA11yViolations(page);
  }
});

test("«Ніч»: контраст на брони туриста, кабинете партнёра, персонале и бронях партнёра", async ({ page }) => {
  const orgId = "00000000-0000-4000-8000-00000000a001";
  const state = apiMockState.get(page)!;
  state.partner.orgs = [{ id: orgId, name: "ТОВ «Смерека»", role: "ORG_OWNER" }];
  state.partner.places = [
    {
      id: PARTNER_PLACE,
      orgId,
      role: "ORG_OWNER",
      status: "published",
      name: { uk: "Садиба «Під Смерекою»" },
      address: null,
      description: null,
      phone: null,
      weekly: [],
      media: [],
      moderation: null,
      version: 1,
    },
  ];
  const bookings = await installBookingsMock(page);
  bookings.bookings.push(bookingDto({ id: "00000000-0000-4000-8000-000000000499" }));
  await page.route("**/partner/organizations/*/staff", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        members: [
          {
            assignmentId: "00000000-0000-4000-8000-00000000c001",
            userId: "00000000-0000-4000-8000-00000000d001",
            displayName: "Олена Коваль",
            username: "olena",
            role: "ORG_OWNER",
            grantedAt: "2026-10-01T08:00:00.000Z",
            isMe: true,
          },
        ],
        invites: [],
      },
    }),
  );
  await page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
  const screens: [string, string][] = [
    ["/#/bookings", "Мої бронювання"],
    ["/#/partner", "Кабінет партнера"],
    [`/#/partner/org/${orgId}/staff`, "Співробітники"],
    [`/#/partner/place/${PARTNER_PLACE}/bookings`, "Бронювання"],
  ];
  for (const [path, heading] of screens) {
    await page.goto(path);
    await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
    await expect(html(page)).toHaveAttribute("data-theme", "night");
    await expectNoSeriousA11yViolations(page);
  }
});
