// Сверка дизайна с эталоном (не проверка): скриншоты экранов в DESIGN_SHOTS_DIR. Без переменной — пропуск.
// Фейк карты расставляет маркеры по области карты (__gmFakeScatter), как на эталоне; тайлы настоящей карты здесь не видны.
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { installAssistantMock } from "../../support/assistant-mock.js";
import { bookingDto, installBookingsMock, PARTNER_PLACE } from "../../support/bookings-mock.js";

const DIR = process.env.DESIGN_SHOTS_DIR;
const ONLY = process.env.DESIGN_SHOTS_ONLY;
test.use({ telegram: { startParam: "demoHotel01" } });
test.skip(!DIR, "только по DESIGN_SHOTS_DIR");

const CAT = {
  eat: "00000000-0000-4000-8000-0000000000e1",
  relax: "00000000-0000-4000-8000-0000000000e2",
  shop: "00000000-0000-4000-8000-0000000000e3",
  fun: "00000000-0000-4000-8000-0000000000e4",
};
const cat = (id: string, name: string, homeSection: string) => ({
  id,
  parentId: null,
  code: homeSection,
  name: { uk: name },
  icon: null,
  homeSection,
  sortOrder: 1,
  placeCount: 1,
});
const place = (
  n: number,
  categoryId: string,
  name: string,
  distanceMeters: number,
  openNow: boolean | null,
) => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  categoryId,
  name: { uk: name },
  address: { uk: "смт Татарів" },
  location: { lon: 24.56 + n / 1000, lat: 48.45 + n / 1000 },
  distanceMeters,
  recommended: n === 1,
  adLabel: null,
  openNow,
  phone: null,
  cover: null,
});
const PLACES = [
  place(1, CAT.eat, "Кав'ярня-пекарня «Прут & Пляцок»", 120, true),
  place(2, CAT.relax, "Гуцульські Чани «Жива Ватра»", 240, null),
  place(3, CAT.shop, "Сироварня та Лавка «Полонинський Будз»", 310, true),
  place(4, CAT.eat, "Колиба-музей «У Вуйка Довбуша»", 380, false),
  place(5, CAT.fun, "Підвісна кладка та скелі над Прутом", 490, null),
  place(6, CAT.eat, "Броварня та Паб «Гуцульське Пінне»", 680, true),
];

const ORG_ID = "00000000-0000-4000-8000-00000000a001";

const SHOTS: {
  name: string;
  path: string;
  width: number;
  height: number;
  night?: boolean;
  full?: boolean;
  open?: string;
  click?: string;
  noMap?: boolean;
  /** Мок экрана партнёра / персонала / броней / ассистента (по e2e-мокам). */
  scene?: "partner" | "staff" | "partner-bookings" | "bookings" | "assistant";
}[] = [
  { name: "nearby-split-390-day", path: "/#/nearby", width: 390, height: 844, click: "Список ↓" },
  {
    name: "nearby-split-390-night",
    path: "/#/nearby",
    width: 390,
    height: 844,
    night: true,
    click: "Список ↓",
  },
  { name: "menu-390-night", path: "/#/nearby", width: 390, height: 844, night: true, click: "Меню" },
  { name: "menu-390-day", path: "/#/nearby", width: 390, height: 844, click: "Меню" },
  { name: "nomap-390-day", path: "/#/nearby", width: 390, height: 844, noMap: true },
  { name: "nomap-390-night", path: "/#/nearby", width: 390, height: 844, night: true, noMap: true },
  { name: "nearby-390-day", path: "/#/nearby", width: 390, height: 844 },
  { name: "nearby-390-night", path: "/#/nearby", width: 390, height: 844, night: true },
  { name: "nearby-320-day", path: "/#/nearby", width: 320, height: 740 },
  { name: "nearby-320-night", path: "/#/nearby", width: 320, height: 740, night: true },
  { name: "nearby-list-390-day", path: "/#/nearby", width: 390, height: 844, full: true },
  { name: "nearby-list-390-night", path: "/#/nearby", width: 390, height: 844, night: true, full: true },
  { name: "home-390-day", path: "/", width: 390, height: 844 },
  { name: "home-390-night", path: "/", width: 390, height: 844, night: true },
  { name: "home-320-day", path: "/", width: 320, height: 740 },
  { name: "home-320-night", path: "/", width: 320, height: 740, night: true },
  { name: "home-full-390-day", path: "/", width: 390, height: 844, full: true },
  { name: "home-full-390-night", path: "/", width: 390, height: 844, night: true, full: true },
  { name: "plan-390-day", path: "/#/plan", width: 390, height: 844, full: true },
  { name: "plan-390-night", path: "/#/plan", width: 390, height: 844, night: true, full: true },
  {
    name: "scenario-390-day",
    path: "/#/plan",
    width: 390,
    height: 844,
    full: true,
    open: "Один день у місті",
  },
  {
    name: "scenario-390-night",
    path: "/#/plan",
    width: 390,
    height: 844,
    night: true,
    full: true,
    open: "Один день у місті",
  },
  { name: "favorites-390-day", path: "/#/favorites", width: 390, height: 844 },
  { name: "favorites-390-night", path: "/#/favorites", width: 390, height: 844, night: true },
  { name: "catalog-390-day", path: "/#/section/eat", width: 390, height: 844, full: true },
  { name: "catalog-390-night", path: "/#/section/eat", width: 390, height: 844, night: true, full: true },
  { name: "help-390-day", path: "/#/help", width: 390, height: 844, full: true },
  { name: "help-390-night", path: "/#/help", width: 390, height: 844, night: true, full: true },
  { name: "profile-390-day", path: "/#/profile", width: 390, height: 844, full: true },
  { name: "profile-390-night", path: "/#/profile", width: 390, height: 844, night: true, full: true },
  { name: "place-390-day", path: "/#/place/CAFE", width: 390, height: 844, full: true },
  { name: "place-390-night", path: "/#/place/CAFE", width: 390, height: 844, night: true, full: true },
  ...(["day", "night"] as const).flatMap((mode) =>
    (
      [
        ["partner", "/#/partner", "partner"],
        ["staff", `/#/partner/org/${ORG_ID}/staff`, "staff"],
        ["partner-bookings", `/#/partner/place/${PARTNER_PLACE}/bookings`, "partner-bookings"],
        ["bookings", "/#/bookings", "bookings"],
        ["assistant", `/#/assistant?q=${encodeURIComponent("Де поїсти суші")}`, "assistant"],
        ["about", "/#/about", undefined],
      ] as const
    ).map(([name, path, scene]) => ({
      name: `${name}-390-${mode}`,
      path,
      width: 390,
      height: 844,
      night: mode === "night",
      full: true,
      scene,
    })),
  ),
];

for (const shot of SHOTS.filter((s) => !ONLY || new RegExp(ONLY).test(s.name))) {
  test(shot.name, async ({ page }) => {
    if (shot.noMap) await page.addInitScript(() => delete (window as unknown as { google?: unknown }).google);
    apiMockState.get(page)!.consents = [
      { kind: "terms", version: "2026-11-01-draft" },
      { kind: "privacy", version: "2026-11-01-draft" },
    ];
    await page.route("**/health", (route) =>
      route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
    );
    await page.addInitScript((night) => {
      (window as unknown as { __gmFakeScatter: boolean }).__gmFakeScatter = true;
      if (night) localStorage.setItem("tg.theme", "night");
    }, shot.night ?? false);
    if (shot.path.includes("nearby")) {
      await page.route("**/places/search?**", (route) =>
        route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: { items: PLACES, nextOffset: null, radiusMeters: 500 },
        }),
      );
      await page.route("**/categories?**", (route) =>
        route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            items: [
              cat(CAT.eat, "Де поїсти", "eat"),
              cat(CAT.relax, "Відпочити", "relax"),
              cat(CAT.shop, "Де купити", "shop"),
              cat(CAT.fun, "Розваги", "fun"),
            ],
          },
        }),
      );
    }
    if (shot.scene) {
      const state = apiMockState.get(page)!;
      if (shot.scene !== "assistant" && shot.scene !== "bookings") {
        state.partner.orgs = [{ id: ORG_ID, name: "ТОВ «Смерека»", role: "ORG_OWNER" }];
        state.partner.places = [
          {
            id: PARTNER_PLACE,
            orgId: ORG_ID,
            role: "ORG_OWNER",
            status: "published",
            name: { uk: "Садиба «Під Смерекою»" },
            address: { uk: "Косів, вул. Ринкова, 1" },
            description: null,
            phone: "+380501112233",
            weekly: [],
            media: [],
            moderation: null,
            version: 1,
          },
        ];
      }
      if (shot.scene === "staff")
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
                {
                  assignmentId: "00000000-0000-4000-8000-00000000c002",
                  userId: "00000000-0000-4000-8000-00000000d002",
                  displayName: null,
                  username: "taras_cash",
                  role: "ORG_STAFF",
                  grantedAt: "2026-10-05T08:00:00.000Z",
                  isMe: false,
                },
              ],
              invites: [
                {
                  id: "00000000-0000-4000-8000-00000000e001",
                  role: "ORG_STAFF",
                  state: "active",
                  expiresAt: "2026-11-20T08:00:00.000Z",
                  createdAt: "2026-11-03T08:00:00.000Z",
                  acceptedAt: null,
                  acceptedByName: null,
                },
              ],
            },
          }),
        );
      if (shot.scene === "partner-bookings" || shot.scene === "bookings") {
        const mock = await installBookingsMock(page);
        mock.bookings.push(bookingDto({ id: "00000000-0000-4000-8000-000000000499" }));
      }
      if (shot.scene === "assistant") await installAssistantMock(page);
    }
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(shot.path.replace("CAFE", CAFE_PLACE));
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await expect(page.locator(".kosiv-content").first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    if (shot.open) {
      await page.getByRole("link", { name: shot.open }).click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
    }
    if (shot.click) {
      await page.getByRole("button", { name: shot.click }).click();
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: `${DIR}/${shot.name}.png`, fullPage: shot.full ?? false });
  });
}
