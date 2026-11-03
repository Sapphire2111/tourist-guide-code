// Мок ассистента (POST /assistant/query, /assistant/transcribe) для E2E Mini App: Claude и Google не вызываются —
// ответ по ключевым словам реплики; места — как из каталога (только поля PlaceSummaryDto). Запросы — в state.
import type { Page, Route } from "@playwright/test";
import { REGION_ID } from "./api-mock.js";

const CAFES = "00000000-0000-4000-8000-000000000102";
const HOTELS = "00000000-0000-4000-8000-000000000105";
const MUSEUMS = "00000000-0000-4000-8000-000000000106";

const summary = (id: string, name: string, categoryId: string, lat: number, lon: number) => ({
  id,
  categoryId,
  name: { uk: name },
  address: { uk: "м. Тестове" },
  location: { lon, lat },
  distanceMeters: 300,
  recommended: false,
  adLabel: null,
  openNow: true,
  phone: null,
  cover: null,
  coverPhoto: null,
});

const item = (
  place: ReturnType<typeof summary>,
  over: Partial<{ priceLevel: number | null; kidsFriendly: boolean; description: string | null }> = {},
) => ({
  place,
  priceLevel: null as number | null,
  kidsFriendly: false,
  description: null as string | null,
  descriptionSource: null as string | null,
  descriptionUrl: null as string | null,
  ...over,
  ...(over.description ? { descriptionSource: "ai" } : {}),
});

const intent = (over: Record<string, unknown> = {}) => ({
  kind: "places",
  categories: ["cafes"],
  nameQuery: null,
  radiusMeters: null,
  priceMin: null,
  priceMax: null,
  withKids: false,
  openNow: false,
  clarify: false,
  suggestions: ["cheaper", "kids"],
  ...over,
});

const CAFE_A = summary("00000000-0000-4000-8000-000000000202", "Кав'ярня «Смерека»", CAFES, 48.4512, 24.5612);
const CAFE_B = summary("00000000-0000-4000-8000-000000000211", "Кав'ярня «Ватра»", CAFES, 48.452, 24.562);
const HOTEL = summary("00000000-0000-4000-8000-000000000212", "Готель «Карпати»", HOTELS, 48.453, 24.563);
const MUSEUM_A = summary("00000000-0000-4000-8000-000000000213", "Музей Довбуша", MUSEUMS, 48.454, 24.564);
const MUSEUM_B = summary("00000000-0000-4000-8000-000000000214", "Водоспад Пробій", MUSEUMS, 48.456, 24.566);

export type AssistantMockState = {
  queries: Record<string, unknown>[];
  transcribes: { contentType: string; bytes: number; regionId: string | null }[];
};

function answer(text: string) {
  const t = text.toLowerCase();
  if (t.includes("готель"))
    return {
      intent: intent({ categories: ["hotels"], radiusMeters: 1000, suggestions: ["cheaper"] }),
      items: [item(HOTEL, { priceLevel: 2 })],
      route: null,
      notes: [],
    };
  if (t.includes("екскурс"))
    return {
      intent: intent({ kind: "tour", categories: ["museums"], suggestions: ["kids"] }),
      items: [item(MUSEUM_A, { description: "Музей у Яремчі." }), item(MUSEUM_B)],
      route: { lengthMeters: 320 },
      notes: [],
    };
  if (t.includes("дешевше"))
    return {
      intent: intent({ priceMax: 1, suggestions: ["kids"] }),
      items: [item(CAFE_B, { priceLevel: 1, kidsFriendly: true })],
      route: null,
      notes: [],
    };
  if (t.includes("кав"))
    return {
      intent: intent(),
      items: [
        item(CAFE_A, { priceLevel: 2, description: "Кав'ярня з терасою. Відвідувачі хвалять каву." }),
        item(CAFE_B, { priceLevel: 1, kidsFriendly: true }),
      ],
      route: null,
      notes: [],
    };
  return {
    intent: intent({ categories: [], clarify: true, suggestions: [] }),
    items: [],
    route: null,
    notes: [],
  };
}

export async function installAssistantMock(
  page: Page,
  token = "e2e-session-token",
): Promise<AssistantMockState> {
  const state: AssistantMockState = { queries: [], transcribes: [] };
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(
    (url) => /^\/assistant\/(query|transcribe)$/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (req.headers()["authorization"] !== `Bearer ${token}`)
        return json(route, { error: { code: "UNAUTHENTICATED", messageKey: "errors.unauthenticated" } }, 401);
      if (url.pathname === "/assistant/transcribe") {
        state.transcribes.push({
          contentType: req.headers()["content-type"] ?? "",
          bytes: req.postDataBuffer()?.length ?? 0,
          regionId: url.searchParams.get("regionId"),
        });
        return json(route, { text: "кав'ярня поруч" });
      }
      const body = req.postDataJSON() as { regionId: string; text: string };
      state.queries.push(body);
      if (body.regionId !== REGION_ID) return json(route, { error: { code: "NOT_FOUND" } }, 404);
      return json(route, answer(body.text));
    },
  );
  return state;
}

/**
 * Микрофон без устройства: MediaRecorder и getUserMedia подменяются до загрузки приложения (Opus в WebM), запись —
 * несколько байт; так проверяется путь «кнопка → запись → POST /assistant/transcribe → реплика».
 */
export async function installFakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(
        readonly stream: { getTracks(): { stop(): void }[] },
        readonly opts: { mimeType: string },
      ) {}
      static isTypeSupported(t: string) {
        return t.startsWith("audio/webm");
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["OggS-fake-opus-audio"], { type: this.opts.mimeType }) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: FakeRecorder, configurable: true });
    const devices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
    Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true });
  });
}
