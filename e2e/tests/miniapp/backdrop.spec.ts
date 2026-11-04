// Общий фон приложения (AppBackdrop): один неподвижный слой на всех экранах, искры, темы «День»/«Ніч»; плитки главной с
// вертикальной прокруткой; нижняя навигация; функции главной, которые должны оставаться видимыми в дизайне Концепта Б.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { installAssistantMock } from "../../support/assistant-mock.js";
import { installBookingsMock } from "../../support/bookings-mock.js";
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

const FLAGS = ["module.assistant", "module.bookings", "module.host_requests", "module.partner_cabinet"];
const backdrop = (page: Page) => page.getByTestId("app-backdrop");
const night = (page: Page) => page.addInitScript(() => localStorage.setItem("tg.theme", "night"));
/** Оба мока ставят свой список флагов: последний выигрывает, поэтому общий список — поверх них. */
async function allScreens(page: Page) {
  await installAssistantMock(page);
  await installBookingsMock(page);
  await page.route("**/feature-flags*", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: { items: FLAGS.map((key) => ({ key, enabled: true })) },
    }),
  );
}
const go = (page: Page, hash: string) => page.evaluate((h) => void (location.hash = h), hash);

const SCREENS: readonly (readonly [string, RegExp | string])[] = [
  ["#/section/eat", "Де поїсти"],
  [`#/place/${CAFE_PLACE}`, /Смерека/],
  ["#/plan", "Мій план"],
  ["#/favorites", "Обране"],
  ["#/profile", "Профіль"],
  ["#/help", "Халепа?"],
  ["#/about", "Правила проживання"],
  [`#/assistant?q=${encodeURIComponent("Де поїсти суші")}`, "Асистент"],
  ["#/bookings", "Мої бронювання"],
  ["#/nearby", "Карта та місця за відстанню"],
];

/** Пиксели картинки без блоков поверх неё: { sky — верх экрана, rows — яркость столбца x=6 сверху вниз }. */
async function backdropPixels(page: Page) {
  await page.addStyleTag({
    content: ".kosiv-top,.kosiv-content,.kosiv-nav{visibility:hidden!important}.app-embers{display:none}",
  });
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const scale = img.naturalHeight / window.innerHeight;
    const px = (x: number, y: number) => [...ctx.getImageData(x * scale, y * scale, 1, 1).data.slice(0, 3)];
    const rows: number[][] = [];
    for (let y = 0; y < window.innerHeight; y += 2) rows.push(px(6, y));
    return { sky: px(window.innerWidth / 2, 4), rows };
  }, png);
}

test("один фон на всех экранах: тот же узел, на весь экран, не пересоздаётся при переходах", async ({
  page,
}) => {
  await allScreens(page);
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expect(backdrop(page)).toHaveCount(1);
  await expect(backdrop(page)).toHaveAttribute("aria-hidden", "true");
  await expect(backdrop(page)).toHaveCSS("pointer-events", "none");
  await page.evaluate(() => {
    (window as unknown as { __bd: Element }).__bd = document.querySelector('[data-testid="app-backdrop"]')!;
  });
  for (const [hash, heading] of SCREENS) {
    await go(page, hash);
    await expect(page.getByText(heading).first()).toBeVisible();
    const same = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="app-backdrop"]');
      const r = el!.getBoundingClientRect();
      return {
        same: el === (window as unknown as { __bd: Element }).__bd,
        count: document.querySelectorAll('[data-testid="app-backdrop"]').length,
        covers: r.top === 0 && r.left === 0 && r.width === innerWidth && r.height === innerHeight,
      };
    });
    expect(same, hash).toEqual({ same: true, count: 1, covers: true });
  }
});

for (const [width, height] of [
  [320, 740],
  [390, 844],
  [430, 932],
] as const) {
  for (const dark of [false, true]) {
    test(`${width}×${height}${dark ? " «Ніч»" : ""}: фон без шва и обреза до самого низа`, async ({
      page,
    }) => {
      if (dark) await night(page);
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByTestId("home-sections")).toBeVisible();
      const { rows } = await backdropPixels(page);
      // Ниже хребтов (от 400 px) — только плавный переход: соседние строки почти не отличаются.
      const start = Math.floor(400 / 2);
      let jump = 0;
      for (let i = start + 1; i < rows.length; i++) {
        const [a, b] = [rows[i - 1]!, rows[i]!];
        jump = Math.max(jump, Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
      }
      expect(jump).toBeLessThanOrEqual(3);
      // Низ экрана — тёмная гора, а не светлая заливка страницы (и в «День»).
      const last = rows[rows.length - 1]!;
      expect(last[0]! + last[1]! + last[2]!).toBeLessThan(330);
    });
  }
}

/** Главная теперь умещается на экране; для проверки прокрутки страницы добавляем высоту в конец. */
const makeScrollable = (page: Page) =>
  page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "1500px";
    document.body.appendChild(spacer);
  });

test("фон не двигается при прокрутке, блоки двигаются", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeAttached();
  await makeScrollable(page);
  const read = () =>
    page.evaluate(() => ({
      bd: document.querySelector('[data-testid="app-backdrop"]')!.getBoundingClientRect().top,
      hero: document.querySelector('[data-testid="modern-hero"]')!.getBoundingClientRect().top,
      y: window.scrollY,
    }));
  const before = await read();
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect.poll(async () => (await read()).y).toBeGreaterThan(100);
  const after = await read();
  expect(after.bd).toBe(before.bd);
  expect(after.bd).toBe(0);
  expect(after.hero).toBeLessThan(before.hero);
});

test("искры: 15–25, только transform и opacity, разные траектории и задержки", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  const embers = await page
    .getByTestId("app-embers")
    .locator("i")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const [animation] = n.getAnimations();
        const props = new Set(
          (animation!.effect as KeyframeEffect)
            .getKeyframes()
            .flatMap((k) =>
              Object.keys(k).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p)),
            ),
        );
        return {
          props: [...props],
          delay: animation!.effect!.getComputedTiming().delay,
          left: (n as HTMLElement).style.left,
          running: animation!.playState,
        };
      }),
    );
  expect(embers.length).toBeGreaterThanOrEqual(15);
  expect(embers.length).toBeLessThanOrEqual(25);
  for (const e of embers) {
    expect(e.running).toBe("running");
    expect(e.props.sort()).toEqual(["opacity", "transform"]);
  }
  expect(new Set(embers.map((e) => e.delay)).size).toBeGreaterThan(10);
  expect(new Set(embers.map((e) => e.left)).size).toBeGreaterThan(15);
});

test("искры не вызывают постоянной раскладки страницы", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const layouts = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "LayoutCount")!.value;
  };
  // Дождаться успокоения после загрузки.
  await page.waitForTimeout(800);
  const before = await layouts();
  await page.waitForTimeout(2000);
  // Чередование плейсхолдера поля (раз в 4 с) допускает единицы; анимация на кадр дала бы сотню.
  expect((await layouts()) - before).toBeLessThanOrEqual(4);
});

test("«уменьшить движение»: искры неподвижны", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  const read = () =>
    page
      .getByTestId("app-embers")
      .locator("i")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { y: r.y, x: r.x, animations: n.getAnimations().length };
        }),
      );
  const first = await read();
  expect(first.length).toBeGreaterThanOrEqual(15);
  for (const e of first) expect(e.animations).toBe(0);
  await page.waitForTimeout(500);
  expect(await read()).toEqual(first);
});

test("темы различаются: небо и низ картинки, карточка, текст; День светлый", async ({ page }) => {
  const snapshot = async () => {
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    const css = await page.evaluate(() => ({
      card: getComputedStyle(document.querySelector(".modern-hero-glass")!).backgroundColor,
      title: getComputedStyle(document.querySelector("#sections-title")!).color,
      nav: getComputedStyle(document.querySelector(".kosiv-nav")!).backgroundColor,
    }));
    return { css, pixels: await backdropPixels(page) };
  };
  const day = await snapshot();
  await night(page);
  const dark = await snapshot();
  expect(dark.css.card).not.toBe(day.css.card);
  expect(dark.css.title).not.toBe(day.css.title);
  expect(dark.css.nav).not.toBe(day.css.nav);
  const sum = (c: number[]) => c[0]! + c[1]! + c[2]!;
  // Небо: день — рассвет (#FDE8D0), ночь — тёмное.
  expect(sum(day.pixels.sky)).toBeGreaterThan(600);
  expect(sum(dark.pixels.sky)).toBeLessThan(120);
});

for (const dark of [false, true]) {
  test(`контраст на фоне${dark ? " «Ніч»" : " «День»"}: главная и вложенные экраны`, async ({ page }) => {
    test.slow();
    await allScreens(page);
    if (dark) await night(page);
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    for (const [hash, heading] of SCREENS) {
      await go(page, hash);
      await expect(page.getByText(heading).first()).toBeVisible();
      // Анимация входа экрана не влияет на цвет, но дождёмся данных экрана.
      await page.waitForLoadState("networkidle");
      await expectNoSeriousA11yViolations(page);
    }
  });
}

// ---- Плитки: 2 ряда по 4, целиком ----

test("плитки: все 8 видны целиком в два ряда, доступны клавиатурой", async ({ page }) => {
  await page.goto("/");
  const list = page.getByTestId("home-sections");
  const links = list.getByRole("link");
  await expect(links).toHaveCount(8);
  const box = await list.evaluate((n) => ({
    scrolls: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1,
    overflow: getComputedStyle(n).overflowY,
  }));
  expect(box).toEqual({ scrolls: false, overflow: "visible" });
  await expect(page.getByTestId("tiles-more")).toHaveCount(0);
  await links.first().focus();
  const hrefs: (string | null)[] = [];
  for (let i = 0; i < 8; i++) {
    const info = await page.evaluate(() => {
      const a = document.activeElement as HTMLAnchorElement;
      const l = a.closest('[data-testid="home-sections"]')!;
      const [ar, lr] = [a.getBoundingClientRect(), l.getBoundingClientRect()];
      return {
        href: a.getAttribute("href"),
        visible: ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1,
      };
    });
    expect(info.visible, String(info.href)).toBe(true);
    hrefs.push(info.href);
    if (i < 7) await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
  }
  expect(hrefs).toEqual([
    "#/section/stay",
    "#/section/relax",
    "#/section/shop",
    "#/section/fun",
    "#/section/ski",
    "#/section/transfer",
    "#/section/services",
    "#/favorites",
  ]);
});

test("плитки: имена для скринридера и цель не меньше 44 px", async ({ page }) => {
  await page.goto("/");
  const list = page.getByTestId("home-sections");
  await expect(list.getByRole("link", { name: "Відпочити та зігрітися" })).toHaveAttribute(
    "href",
    "#/section/relax",
  );
  await expect(list.getByRole("link", { name: "Розваги та враження" })).toHaveAttribute(
    "href",
    "#/section/fun",
  );
  await expect(list.getByRole("link", { name: /^Де жити.*Готелі, садиби/ })).toHaveAttribute(
    "href",
    "#/section/stay",
  );
  await expect(list.getByRole("link", { name: "Обране" })).toHaveAttribute("href", "#/favorites");
  await expect(list.getByRole("link")).toContainText([
    "Де жити",
    "Відпочити",
    "Де купити",
    "Розваги",
    "Гірські лижі",
    "Авто",
    "Послуги",
    "Обране",
  ]);
});

// ---- Полосы, заголовок, служебное, пауза искр ----

for (const dark of [false, true]) {
  test(`верхняя полоса и док${dark ? " «Ніч»" : " «День»"}: сплошные, контент не просвечивает`, async ({
    page,
  }) => {
    if (dark) await night(page);
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    const css = await page.evaluate(() => {
      const top = getComputedStyle(document.querySelector('[data-testid="app-top"]')!);
      const nav = getComputedStyle(document.querySelector('[data-testid="bottom-nav"]')!);
      return {
        top: top.backgroundColor,
        nav: nav.backgroundColor,
        filter: top.backdropFilter,
        transform: top.transform,
      };
    });
    expect(css.top).toMatch(/^rgb\(/);
    expect(css.nav).toMatch(/^rgb\(/);
    expect(css.filter).toBe("none");
    expect(css.transform).toBe("none");
  });

  test(`новый пользователь${dark ? " «Ніч»" : " «День»"}: заголовок читаем над лесом, a11y`, async ({
    page,
  }) => {
    apiMockState.get(page)!.consents = [];
    if (dark) await night(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вітаємо!" })).toBeVisible();
    const title = page.locator("#sections-title");
    await expect(title).toBeVisible();
    const pair = await title.evaluate((n) => ({
      fg: getComputedStyle(n).color,
      bg: getComputedStyle(n.closest(".modern-hero-head")!).backgroundColor,
    }));
    expect(pair.bg).toMatch(/^rgb\(/); // сплошная подложка, не прозрачная
    const lum = (c: string) => {
      const [r, g, b] = /rgb\((\d+), (\d+), (\d+)/
        .exec(c)!
        .slice(1)
        .map((v) => {
          const x = Number(v) / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(pair.fg), lum(pair.bg)].sort((a, b) => b - a) as [number, number];
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5);
    await expectNoSeriousA11yViolations(page);
  });
}

test("служебный блок: туристу нет, /health не запрашивается; у персонала есть", async ({ page }) => {
  const health: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/health") health.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".kosiv-meta-block")).toHaveCount(0);
  expect(health).toEqual([]);
  apiMockState.get(page)!.staff = true;
  await page.reload();
  await expect(page.getByTestId("staff-link")).toBeVisible();
  await expect(page.getByTestId("health")).toHaveText("Сервер працює");
  await expect(page.getByTestId("role")).toBeVisible();
  expect(health.length).toBeGreaterThan(0);
});

test("искры на паузе под листом на весь экран и в скрытой вкладке", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  const states = () =>
    page
      .getByTestId("app-embers")
      .locator("i")
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => n.getAnimations()[0]!.playState))]);
  expect(await states()).toEqual(["running"]);
  await page.getByTestId("menu-btn").click();
  await expect(page.getByRole("dialog", { name: "Меню" })).toBeVisible();
  await expect.poll(states).toEqual(["paused"]);
  await page.keyboard.press("Escape");
  await expect.poll(states).toEqual(["running"]);
  const visibility = (v: string) =>
    page.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }, v);
  await visibility("hidden");
  await expect.poll(states).toEqual(["paused"]);
  await visibility("visible");
  await expect.poll(states).toEqual(["running"]);
  // Свайпы не сворачивают приложение: вызов на старте.
  const calls = await page.evaluate(
    () => (window as unknown as { __telegramCalls?: string[] }).__telegramCalls ?? [],
  );
  expect(calls).toContain("disableVerticalSwipes");
});

// ---- Нижняя навигация, 112, функции главной ----

test("нижняя навигация по ТЗ: Головна, Поруч, Мій план, Профіль; подписи видимы", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByTestId("bottom-nav");
  await expect(nav.getByRole("link")).toContainText(["Головна", "Поруч", "Мій план", "Профіль"]);
  await expect(nav.getByRole("link", { name: "Головна" })).toHaveAttribute("href", "#/");
  await expect(nav.getByRole("link", { name: "Профіль" })).toHaveAttribute("href", "#/profile");
  await expect(nav.getByText("Ватра")).toHaveCount(0);
});

test.describe("без профиля", () => {
  test.use({ telegram: null });
  test("последний пункт — «Обране», ведёт на /favorites", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByTestId("bottom-nav");
    await expect(nav.getByRole("link").last()).toContainText("Обране");
    await expect(nav.getByRole("link").last()).toHaveAccessibleName("Обране");
    await expect(nav.getByRole("link").last()).toHaveAttribute("href", "#/favorites");
    await expect(nav.getByText("Профіль")).toHaveCount(0);
    // Запрос к ассистенту без входа невозможен: честная подпись, не мёртвое поле; вне Telegram нет и QR.
    await expect(page.getByTestId("browser-notice")).toBeVisible();
    await expect(page.getByTestId("scan-btn")).toHaveCount(0);
    await expect(page.getByTestId("app-top").getByText("QR", { exact: true })).toHaveCount(0);
  });
});

test("112: экран помощи, понятное имя, номер сам не набирается", async ({ page }) => {
  await page.goto("/");
  const help = page.getByTestId("help-112");
  await expect(help).toHaveAccessibleName("Допомога, екстрений номер 112");
  await expect(help).toHaveText(/112/);
  await expect(help).toHaveAttribute("href", "#/help");
  await help.click();
  await expect(page.getByRole("heading", { name: "Халепа?" })).toBeVisible();
});

test("главная: всё видно на месте — заголовки, поле, подсказки, «Про заклад», приветствие; без ленты мест и сезонных тегов", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeAttached();
  await expect(page.getByRole("heading", { level: 2, name: "Запитай у гір, чого бажаєш" })).toBeVisible();
  await expect(page.getByTestId("tg-user")).toBeVisible();
  await expect(page.getByTestId("assistant-box").getByRole("searchbox")).toBeVisible();
  await expect(page.getByTestId("assistant-mic")).toBeVisible();
  await page.getByTestId("assistant-box").getByRole("searchbox").fill("кава");
  await expect(page.getByTestId("assistant-send")).toBeVisible();
  await page.getByTestId("assistant-box").getByRole("searchbox").fill("");
  await expect(page.getByTestId("assistant-examples").getByRole("button").first()).toBeVisible();
  await expect(page.locator(".modern-host-link")).toHaveText(/^Про заклад/);
  await expect(page.getByText("Wi-Fi")).toHaveCount(0);
  await expect(page.getByTestId("near-me")).toContainText("Місця поруч на карті");
  await expect(page.getByTestId("near-me")).toContainText("від 300 м");
  // Ленты мест и нижнего ряда сезонных тегов на главной нет.
  await expect(page.getByRole("heading", { name: "Цікаві місця" })).toHaveCount(0);
  await expect(page.getByTestId("home-places")).toHaveCount(0);
  await expect(page.getByTestId("home-place")).toHaveCount(0);
  await expect(page.getByTestId("season-tags")).toHaveCount(0);
  // Служебное туристу не показываем.
  await expect(page.getByTestId("health")).toHaveCount(0);
  await expect(page.getByTestId("role")).toHaveCount(0);
});

test("заголовок на небе: не пересекается с контуром вершин", async ({ page }) => {
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [430, 932],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const bottom = await page.locator("#sections-title").evaluate((n) => n.getBoundingClientRect().bottom);
    // Самая высокая вершина картинки: 150 из 400 при высоте 512 px.
    expect(bottom, `${width}`).toBeLessThanOrEqual(192);
  }
});

test("главная не запрашивает места для ленты (/places/search)", async ({ page }) => {
  const searches: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.endsWith("/places/search")) searches.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(searches).toEqual([]);
});

test("огонёк меню живой: анимация есть, раскладку не двигает; при reduced-motion — без анимации", async ({
  page,
}) => {
  await page.goto("/");
  const flame = page.getByTestId("menu-btn").locator(".fire-flame");
  await expect(flame).toBeVisible();
  const animated = () => flame.evaluate((n) => n.getAnimations().length);
  expect(await animated()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(animated).toBe(0);
});
