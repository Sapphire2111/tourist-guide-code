// Мок api для E2E Mini App (api в E2E не поднят): вход через Telegram, профиль /me и контекст QR.
// Состояние (язык, согласия, разрешения боту) — на страницу, меняется запросами, как на сервере.
// Коды QR — как в seed api (seedQrPoints): demoHotel01 — «Тестовий готель», demoHotelOff1 — деактивирован.
import type { Page, Route } from "@playwright/test";
import { installBlock5Mock, newBlock5State, type Block5State } from "./block5-mock.js";
import { installPartnerMock, newPartnerState, type PartnerMockState } from "./partner-mock.js";

const ANON = "7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f";
export const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const REGION = {
  id: REGION_ID,
  code: "test-region",
  name: { uk: "Тестовий регіон", en: "Test region" },
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
};

const neutral = (status: "inactive" | "not_found" | "invalid" | "default") => ({
  status,
  entryType: "default",
  region: REGION,
  qrPoint: null,
  venue: null,
  entryContextId: "00000000-0000-4000-8000-0000000000c1",
  anonymousId: ANON,
});

export function contextFor(code: string) {
  if (code === "demoHotel01")
    return {
      status: "ok",
      entryType: "hotel",
      region: REGION,
      qrPoint: {
        id: "00000000-0000-4000-8000-0000000000b1",
        type: "hotel",
        placeId: HOTEL_PLACE,
        campaign: null,
      },
      venue: {
        name: { uk: "Тестовий готель", en: "Test hotel" },
        description: { uk: "Готель для перевірки входу за QR." },
        address: { uk: "м. Тестове, вул. Центральна, 1" },
        phone: "+380501234567",
        website: "https://hotel.example",
        telegram: "test_hotel",
      },
      entryContextId: "00000000-0000-4000-8000-0000000000c1",
      anonymousId: ANON,
    };
  if (code === "demoHotelOff1") return neutral("inactive");
  return neutral(/^(?!\d+$)[A-Za-z0-9_-]{10,64}$/.test(code) ? "not_found" : "invalid");
}

// --- Каталог гида (блок 4): категории, места, «Халепа?», избранное ---
export const HOTEL_PLACE = "00000000-0000-4000-8000-000000000201";
export const CAFE_PLACE = "00000000-0000-4000-8000-000000000202";
export const AD_PLACE = "00000000-0000-4000-8000-000000000203";
const EAT = "00000000-0000-4000-8000-000000000101";
const CAFES = "00000000-0000-4000-8000-000000000102";
const SHOP = "00000000-0000-4000-8000-000000000103";

const categories = [
  {
    id: EAT,
    parentId: null,
    code: "eat",
    name: { uk: "Де поїсти" },
    icon: null,
    homeSection: "eat",
    sortOrder: 1,
    placeCount: 2,
  },
  {
    id: CAFES,
    parentId: EAT,
    code: "cafes",
    name: { uk: "Кав'ярні" },
    icon: null,
    homeSection: null,
    sortOrder: 1,
    placeCount: 1,
  },
  {
    id: SHOP,
    parentId: null,
    code: "shop",
    name: { uk: "Де купити" },
    icon: null,
    homeSection: "shop",
    sortOrder: 2,
    placeCount: 0,
  },
];

const summary = (id: string, name: string, lat: number, lon: number, over: Record<string, unknown> = {}) => ({
  id,
  categoryId: CAFES,
  name: { uk: name },
  address: { uk: "м. Тестове" },
  location: { lon, lat },
  distanceMeters: null as number | null,
  recommended: false,
  adLabel: null as string | null,
  openNow: true as boolean | null,
  phone: "+380501112233",
  cover: null,
  ...over,
});

const places = [
  summary(HOTEL_PLACE, "Тестовий готель", 48.45, 24.56, { categoryId: EAT, openNow: null }),
  summary(CAFE_PLACE, "Кав'ярня «Смерека»", 48.4512, 24.5612, { recommended: true }),
  summary(AD_PLACE, "Піцерія «Реклама»", 48.4535, 24.5635, { adLabel: "advertising", openNow: false }),
];

/** Населённые пункты региона (GET /localities): кав'ярня — в Яремчі, піцерія — в Татарові. */
export const LOCALITY_YAREMCHE = "00000000-0000-4000-8000-000000000501";
export const LOCALITY_TATARIV = "00000000-0000-4000-8000-000000000502";
const localities = [
  { id: LOCALITY_YAREMCHE, code: "yaremche", name: { uk: "Яремче", en: "Yaremche" }, placeCount: 1 },
  { id: LOCALITY_TATARIV, code: "tatariv", name: { uk: "Татарів", en: "Tatariv" }, placeCount: 1 },
].map((l, i) => ({ ...l, aliases: [], location: { lon: 24.56, lat: 48.45 }, sortOrder: i + 1 }));
const placeLocality: Record<string, string> = {
  [CAFE_PLACE]: LOCALITY_YAREMCHE,
  [AD_PLACE]: LOCALITY_TATARIV,
};

function distance(a: { lat: number; lon: number }, lat: number, lng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(lat)) * Math.sin(rad(lng - a.lon) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const card = (p: (typeof places)[number], favorite: boolean | null) => ({
  ...p,
  regionId: REGION.id,
  category: { id: p.categoryId, parentId: null, name: { uk: "Кав'ярні" }, icon: null },
  description: { uk: "Опис місця для перевірки картки." },
  website: "https://place.example",
  telegram: null,
  verifiedAt: "2026-10-01T00:00:00Z",
  // «Це мій заклад?» (0031): места мока без организации-партнёра.
  claimable: true,
  photos: [
    {
      mediaAssetId: p.id,
      alt: { uk: `Фото: ${p.name.uk}` },
      width: 800,
      height: 450,
      isCover: true,
      variants: [
        { name: "w800", url: "https://cdn.example/photo-w800.jpg", width: 800, height: 450, expiresAt: null },
      ],
    },
  ],
  tags: [
    { id: "00000000-0000-4000-8000-000000000301", code: "wifi", name: { uk: "Wi-Fi" }, group: "amenity" },
  ],
  schedule: {
    timezone: "Europe/Kyiv",
    weekly: [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensAt: "09:00", closesAt: "21:00" })),
    exceptions: [],
  },
  openUntil: p.openNow ? "21:00" : null,
  favorite,
});

export const EMERGENCY = [
  {
    id: "00000000-0000-4000-8000-000000000401",
    kind: "police",
    name: { uk: "Поліція" },
    phone: "102",
    description: null,
    sortOrder: 1,
  },
  {
    id: "00000000-0000-4000-8000-000000000402",
    kind: "mountain_rescue",
    name: { uk: "Гірська рятувальна служба" },
    phone: "+380342000000",
    description: { uk: "Цілодобово" },
    sortOrder: 2,
  },
];

export type ApiMockState = Block5State & {
  language: string;
  displayName: string | null;
  consents: { kind: string; version: string }[];
  /** Строки messaging_consents: нет ключа — строки нет (разрешение ни разу не давалось). */
  messaging: Partial<Record<"service" | "marketing", boolean>>;
  privacyRequests: { id: string; kind: string; status: string; createdAt: string }[];
  /** Сколько раз вызван GET /context (должен быть один за открытие). */
  contextCalls: number;
  /** Избранное (placeId). */
  favorites: string[];
  /** Запросы поиска мест (query). */
  searches: Record<string, string>[];
  /** Принятые события аналитики (POST /analytics/events). */
  events: { event: string; props: Record<string, unknown>; regionId: string | null; anonymousId?: string }[];
  /** Кабинет партнёра (блок 6). */
  partner: PartnerMockState;
};

/** Состояние мока страницы — для проверок в тесте. */
export const apiMockState = new WeakMap<Page, ApiMockState>();

export async function installApiMock(page: Page): Promise<ApiMockState> {
  const state: ApiMockState = {
    language: "uk",
    displayName: null,
    consents: [],
    messaging: {},
    privacyRequests: [],
    contextCalls: 0,
    favorites: [],
    searches: [],
    events: [],
    partner: newPartnerState(),
    ...newBlock5State(),
  };
  apiMockState.set(page, state);
  const TOKEN = "e2e-session-token";
  const consentDto = (c: { kind: string; version: string }) => ({
    ...c,
    status: "accepted",
    grantedAt: "2026-11-02T00:00:00Z",
    withdrawnAt: null,
  });
  const me = () => ({
    id: "00000000-0000-4000-8000-0000000000d1",
    status: "active",
    language: state.language,
    displayName: state.displayName,
    telegram: null,
    consents: state.consents.map(consentDto),
    messagingConsents: (["service", "marketing"] as const)
      .filter((purpose) => state.messaging[purpose] !== undefined)
      .map((purpose) => ({
        purpose,
        granted: state.messaging[purpose]!,
        grantedAt: "2026-11-02T00:00:00Z",
        withdrawnAt: state.messaging[purpose] ? null : "2026-11-02T00:00:00Z",
      })),
    privacyRequests: state.privacyRequests,
    staffMode: state.staff,
  });
  // api на другом origin, чем страница: CORS-заголовки, как у настоящего api (Bearer → preflight).
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(
    (url) => /^\/(auth\/telegram|me|me\/.+|context|context\/.+)$/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (path === "/auth/telegram") {
        const initData = new URLSearchParams((req.postDataJSON() as { initData: string }).initData);
        return json(
          route,
          {
            token: TOKEN,
            session: {
              id: "00000000-0000-4000-8000-0000000000e1",
              userId: "00000000-0000-4000-8000-0000000000d1",
              channel: "telegram",
              expiresAt: "2099-01-01T00:00:00Z",
              activeRegionId: null,
              grants: [],
            },
            isNewUser: state.consents.length === 0,
            startParam: initData.get("start_param"),
          },
          201,
        );
      }
      // Открытие без QR — регион по умолчанию (не скан).
      if (path === "/context") {
        state.contextCalls += 1;
        return json(route, neutral("default"));
      }
      if (path.startsWith("/context/")) {
        state.contextCalls += 1;
        return json(route, contextFor(decodeURIComponent(path.slice("/context/".length))));
      }
      // Профиль — только с сессией, как @RequireAuth на сервере.
      if (path.startsWith("/me") && req.headers()["authorization"] !== `Bearer ${TOKEN}`)
        return json(route, { error: { code: "UNAUTHENTICATED", messageKey: "errors.unauthenticated" } }, 401);
      if (path === "/me" && method === "PATCH") {
        const body = req.postDataJSON() as { language?: string; displayName?: string | null };
        if (body.language) state.language = body.language;
        if (body.displayName !== undefined) state.displayName = body.displayName;
        return json(route, me());
      }
      if (path === "/me") return json(route, me());
      if (path === "/me/consents") {
        const body = req.postDataJSON() as { kind: string; version: string };
        state.consents = [...state.consents.filter((c) => c.kind !== body.kind), body];
        return json(route, consentDto(body));
      }
      if (path === "/me/messaging-consent") {
        const body = req.postDataJSON() as { purpose: "service" | "marketing"; granted: boolean };
        if (body.purpose === "marketing" && body.granted && !state.messaging.service)
          return json(
            route,
            { error: { code: "UNPROCESSABLE", messageKey: "errors.messaging.serviceConsentRequired" } },
            422,
          );
        state.messaging[body.purpose] = body.granted;
        if (body.purpose === "service" && !body.granted && state.messaging.marketing !== undefined)
          state.messaging.marketing = false;
        return json(route, me().messagingConsents);
      }
      if (path === "/me/privacy-requests") {
        const body = req.postDataJSON() as { kind: string };
        let request = state.privacyRequests.find((r) => r.kind === body.kind);
        if (!request) {
          request = {
            id: `00000000-0000-4000-8000-00000000000${state.privacyRequests.length + 1}`,
            kind: body.kind,
            status: "received",
            createdAt: "2026-11-02T00:00:00Z",
          };
          state.privacyRequests.push(request);
        }
        return json(route, request, 201);
      }
      return json(route, { error: { code: "NOT_FOUND" } }, 404);
    },
  );
  // Каталог гида: только с regionId региона из контекста (как RegionQueryDto на сервере).
  await page.route(
    (url) =>
      /^\/(categories|localities|places\/.+|favorites(\/.+)?|emergency-contacts|analytics\/events)$/.test(
        url.pathname,
      ),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (path === "/analytics/events") {
        const body = req.postDataJSON() as { events: ApiMockState["events"] };
        state.events.push(...body.events);
        return json(route, { accepted: body.events.length }, 202);
      }
      const query = Object.fromEntries(url.searchParams);
      const regionId =
        method === "POST" ? (req.postDataJSON() as { regionId?: string }).regionId : query.regionId;
      if (regionId !== REGION.id) return json(route, { error: { code: "NOT_FOUND" } }, 404);
      if (path === "/categories") return json(route, { items: categories });
      if (path === "/localities") return json(route, { items: localities });
      if (path === "/emergency-contacts") return json(route, { items: EMERGENCY });
      if (path === "/places/search") {
        state.searches.push(query);
        const localityIds = url.searchParams.getAll("localityIds").flatMap((v) => v.split(","));
        // Как api: с localityIds радиус по умолчанию не ставится.
        const radius = query.radius ? Number(query.radius) : localityIds.length ? Infinity : 500;
        const lat = query.lat ? Number(query.lat) : undefined;
        const lng = query.lng ? Number(query.lng) : undefined;
        const inCategory = (p: (typeof places)[number]) =>
          !query.category ||
          p.categoryId === query.category ||
          categories.some((c) => c.id === p.categoryId && c.parentId === query.category);
        const items = places
          .filter((p) => p.id !== HOTEL_PLACE)
          .filter(inCategory)
          .filter((p) => localityIds.length === 0 || localityIds.includes(placeLocality[p.id] ?? ""))
          .filter((p) => !query.q || p.name.uk.toLowerCase().includes(query.q.toLowerCase()))
          .map((p) => ({
            ...p,
            distanceMeters: lat !== undefined && lng !== undefined ? distance(p.location, lat, lng) : null,
          }))
          .filter((p) => p.distanceMeters === null || p.distanceMeters <= radius)
          .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
        return json(route, {
          items,
          nextOffset: null,
          radiusMeters: lat !== undefined && Number.isFinite(radius) ? radius : null,
        });
      }
      const signedIn = req.headers()["authorization"] === `Bearer ${TOKEN}`;
      const placeId = /^\/places\/([^/]+)$/.exec(path)?.[1];
      if (placeId) {
        const p = places.find((x) => x.id === placeId);
        if (!p) return json(route, { error: { code: "NOT_FOUND" } }, 404);
        return json(route, card(p, signedIn ? state.favorites.includes(p.id) : null));
      }
      if (!signedIn)
        return json(route, { error: { code: "UNAUTHENTICATED", messageKey: "errors.unauthenticated" } }, 401);
      if (path === "/favorites" && method === "GET")
        return json(route, { items: places.filter((p) => state.favorites.includes(p.id)) });
      if (path === "/favorites" && method === "POST") {
        const { placeId: id } = req.postDataJSON() as { placeId: string };
        if (!state.favorites.includes(id)) state.favorites.unshift(id);
        return json(route, { placeId: id, createdAt: "2026-11-02T00:00:00Z" }, 201);
      }
      const removed = /^\/favorites\/([^/]+)$/.exec(path)?.[1];
      if (removed && method === "DELETE") {
        state.favorites = state.favorites.filter((f) => f !== removed);
        return route.fulfill({ status: 204, headers: cors });
      }
      return json(route, { error: { code: "NOT_FOUND" } }, 404);
    },
  );
  await installBlock5Mock(page, state, json, cors, TOKEN);
  await installPartnerMock(page, state.partner, TOKEN);
  return state;
}
