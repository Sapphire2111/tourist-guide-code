// Мок api для E2E Mini App (api в E2E не поднят): вход через Telegram, профиль /me и контекст QR.
// Состояние (язык, согласия, разрешения боту) — на страницу, меняется запросами, как на сервере.
// Коды QR — как в seed api (seedQrPoints): demoHotel01 — «Тестовий готель», demoHotelOff1 — деактивирован.
import type { Page, Route } from "@playwright/test";

const ANON = "7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f";
const REGION = {
  id: "00000000-0000-4000-8000-0000000000a1",
  code: "test-region",
  name: { uk: "Тестовий регіон", en: "Test region" },
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
};

const neutral = (status: "inactive" | "not_found" | "invalid") => ({
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
      qrPoint: { id: "00000000-0000-4000-8000-0000000000b1", type: "hotel", placeId: null, campaign: null },
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

export type ApiMockState = {
  language: string;
  displayName: string | null;
  consents: { kind: string; version: string }[];
  /** Строки messaging_consents: нет ключа — строки нет (разрешение ни разу не давалось). */
  messaging: Partial<Record<"service" | "marketing", boolean>>;
  privacyRequests: { id: string; kind: string; status: string; createdAt: string }[];
  /** Сколько раз вызван GET /context (должен быть один за открытие). */
  contextCalls: number;
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
  });
  // api на другом origin, чем страница: CORS-заголовки, как у настоящего api (Bearer → preflight).
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(
    (url) => /^\/(auth\/telegram|me|me\/.+|context\/.+)$/.test(url.pathname),
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
  return state;
}
