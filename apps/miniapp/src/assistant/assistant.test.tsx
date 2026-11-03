import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createApiClient, type ApiSchemas } from "@tg/api-client";
import type { Analytics } from "../guide/analytics.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import { LOCATION_STORAGE_KEY, LocationProvider } from "../guide/LocationProvider.js";
import { setMapLoaderForTests } from "../guide/MapSlot.js";
import type { PlacesMapProps } from "../guide/PlacesMap.js";
import type { GuideApi, PlaceSummary } from "../guide/types.js";
import { ApiCallError } from "../host/types.js";
import { Assistant, DIALOG_KEY } from "./Assistant.js";
import {
  createAssistantApi,
  type AssistantApi,
  type AssistantAsk,
  type AssistantIntent,
  type AssistantResult,
} from "./assistant-api.js";
import { AssistantBox } from "./AssistantBox.js";
import { loadDialog } from "./dialog-store.js";
import { recordMime } from "./recorder.js";

const REGION = "00000000-0000-4000-8000-0000000000a1";
const CAFES = "00000000-0000-4000-8000-000000000102";
const MUSEUMS = "00000000-0000-4000-8000-000000000103";

beforeAll(() => {
  // Карта без Leaflet: порядок мест и признак маршрута — в атрибутах.
  setMapLoaderForTests(async () => ({
    default: (p: PlacesMapProps) => (
      <div data-testid="map" data-route={String(Boolean(p.route))} data-n={p.places.length} />
    ),
  }));
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  sessionStorage.clear();
  localStorage.clear();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const place = (n: number, over: Partial<PlaceSummary> = {}): PlaceSummary => ({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  name: { uk: `Місце ${n}` },
  categoryId: CAFES,
  location: { lat: 48.4 + n / 100, lng: 24.5 },
  distanceMeters: n * 100,
  cover: null,
  openNow: true,
  recommended: false,
  adLabel: null,
  ...over,
});

const intent = (over: Partial<AssistantIntent> = {}): AssistantIntent => ({
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

const result = (over: Partial<AssistantResult> = {}): AssistantResult => ({
  intent: intent(),
  items: [
    {
      place: place(1),
      priceLevel: 1,
      kidsFriendly: true,
      description: "Кафе з терасою.",
      descriptionSource: "ai",
      descriptionUrl: null,
    },
    {
      place: place(2),
      priceLevel: null,
      kidsFriendly: false,
      description: null,
      descriptionSource: null,
      descriptionUrl: null,
    },
  ],
  route: null,
  notes: [],
  ...over,
});

function env(): GuideEnv {
  const api = {
    categories: vi.fn(async () => [
      { id: CAFES, parentId: null, code: "cafes", name: { uk: "Кафе" }, homeSection: "eat" as const },
      { id: MUSEUMS, parentId: null, code: "museums", name: { uk: "Музеї" }, homeSection: "fun" as const },
    ]),
  } as unknown as GuideApi;
  return {
    api,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
    base: { name: "Тестовий готель", point: { lat: 48.4, lng: 24.5 } },
    regionId: REGION,
    signedIn: true,
  };
}

function fakeAssistant(over: Partial<AssistantApi> = {}) {
  return {
    ask: vi.fn(over.ask ?? (async (_req: AssistantAsk) => result())),
    transcribe: vi.fn(over.transcribe ?? (async (_audio: Blob) => "кава")),
  };
}

describe("Assistant: диалог", () => {
  it("запрос с главной: что ищем, места из ответа, цена и описание с пометкой ИИ, карта", async () => {
    const api = fakeAssistant();
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="недорога кав'ярня" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(api.ask).toHaveBeenCalledWith({
      text: "недорога кав'ярня",
      point: { lat: 48.4, lng: 24.5 },
      history: [],
      previous: null,
    });
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: Кафе");
    expect(screen.getByTestId("assistant-status").textContent).toBe("Знайдено в каталозі: 2");
    const items = screen.getAllByTestId("assistant-place");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Місце 1");
    expect(items[0]!.textContent).toContain("Недорого");
    expect(items[0]!.textContent).toContain("Підходить для дітей");
    expect(items[0]!.textContent).not.toContain("Згенеровано ШІ");
    expect(items[1]!.textContent).not.toContain("Недорого");
    expect((await screen.findByTestId("map")).dataset.route).toBe("false");
  });

  it("чип уточнения — следующая реплика с контекстом диалога (прежние реплики и намерение)", async () => {
    const api = fakeAssistant();
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="кав'ярня" />
      </GuideProvider>,
    );
    await flush();
    api.ask.mockResolvedValueOnce(result({ intent: intent({ priceMax: 1 }) }));
    fireEvent.click(screen.getByRole("button", { name: "Дешевше" }));
    await flush();
    expect(api.ask).toHaveBeenLastCalledWith({
      text: "Дешевше",
      point: { lat: 48.4, lng: 24.5 },
      history: ["кав'ярня"],
      previous: intent(),
    });
    const replies = screen.getAllByTestId("assistant-reply").map((r) => r.textContent);
    expect(replies).toEqual(["Шукаю: Кафе", "Шукаю: Кафе, недорого"]);
  });

  it("выбор «Локація» уходит в запрос (localityIds); вход по QR — без выбора туриста", async () => {
    const YAREMCHE = "00000000-0000-4000-8000-000000000301";
    const TATARIV = "00000000-0000-4000-8000-000000000302";
    const withLocalities = (): GuideEnv => {
      const e = env();
      (e.api as unknown as { localities: unknown }).localities = vi.fn(async () => [
        { id: YAREMCHE, code: "yaremche", name: { uk: "Яремче" }, placeCount: 3 },
        { id: TATARIV, code: "tatariv", name: { uk: "Татарів" }, placeCount: 2 },
      ]);
      return e;
    };
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: REGION, ids: [YAREMCHE] }));
    const api = fakeAssistant();
    render(
      <GuideProvider value={withLocalities()}>
        <LocationProvider>
          <Assistant api={api} initialQuery="кава" />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(api.ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "кава", localityIds: [YAREMCHE] }),
    );
    cleanup();

    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: REGION, ids: [YAREMCHE] }));
    const qr = fakeAssistant();
    render(
      <GuideProvider value={withLocalities()}>
        <LocationProvider venueEntry>
          <Assistant api={qr} initialQuery="кава" />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(qr.ask).toHaveBeenCalled();
    expect(qr.ask.mock.calls.at(-1)![0]).not.toHaveProperty("localityIds");
  });

  it("радиус в подписи — только без названного пункта (по пункту ищем без радиуса)", async () => {
    const api = fakeAssistant({
      ask: vi.fn(async () => result({ intent: intent({ radiusMeters: 500 }) })),
    });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="кава в 500 м" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    const plain = screen.getByTestId("assistant-reply").textContent;
    expect(plain).toMatch(/^Шукаю: Кафе, у радіусі .*500/);
    cleanup();
    const named = fakeAssistant({
      ask: vi.fn(async () => result({ intent: intent({ radiusMeters: 500, locality: "yaremche" }) })),
    });
    render(
      <GuideProvider value={env()}>
        <Assistant api={named} initialQuery="кава в Яремчі" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: Кафе");
  });

  it("экскурсия: маршрут на карте, номера остановок, Вікіпедія — ссылкой", async () => {
    const api = fakeAssistant({
      ask: vi.fn(async () =>
        result({
          intent: intent({ kind: "tour", categories: ["museums"] }),
          route: { lengthMeters: 1500 },
          items: [
            {
              place: place(1, { categoryId: MUSEUMS }),
              priceLevel: null,
              kidsFriendly: false,
              description: "Музей у Яремчі.",
              descriptionSource: "wikipedia",
              descriptionUrl: "https://uk.wikipedia.org/wiki/M",
            },
            {
              place: place(3, { categoryId: MUSEUMS }),
              priceLevel: null,
              kidsFriendly: false,
              description: null,
              descriptionSource: null,
              descriptionUrl: null,
            },
          ],
        }),
      ),
    });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="екскурсія" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: Музеї, маршрут");
    expect(screen.getByTestId("assistant-route").textContent).toBe(
      "Маршрут екскурсії: зупинок — 2, між ними ≈ 1,5 км по прямій",
    );
    expect(screen.getByText("Зупинка 1")).toBeDefined();
    expect(screen.getByText("Зупинка 2")).toBeDefined();
    expect(screen.getByRole("link", { name: "З Вікіпедії (CC BY-SA 4.0)" }).getAttribute("href")).toBe(
      "https://uk.wikipedia.org/wiki/M",
    );
    expect((await screen.findByTestId("map")).dataset.route).toBe("true");
  });

  it("непонятный запрос — просьба уточнить; ошибка api — текст по messageKey сервера", async () => {
    const api = fakeAssistant({
      ask: vi.fn(async () => result({ intent: intent({ clarify: true, categories: [] }), items: [] })),
    });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="як справи" />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("assistant-reply").textContent).toContain("Уточніть, будь ласка");
    expect(screen.queryByTestId("assistant-places")).toBeNull();

    api.ask.mockRejectedValueOnce(
      new ApiCallError(503, "errors.assistant.unavailable", "SERVICE_UNAVAILABLE"),
    );
    fireEvent.change(screen.getByLabelText("Що шукаєте?"), { target: { value: "кава" } });
    fireEvent.click(screen.getByRole("button", { name: "Знайти" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "Асистент тимчасово недоступний. Скористайтеся розділами або пошуком.",
    );
  });
});

describe("Assistant: «Назад» из карточки", () => {
  it("адрес без запроса, диалог восстанавливается без повторного запроса; «Новий пошук» очищает", async () => {
    const api = fakeAssistant();
    const first = render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="кав'ярня" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(window.location.hash).toBe("#/assistant");
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(2);
    first.unmount();

    // Вернулись (#/assistant без q): тот же диалог, api не вызывается.
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} />
      </GuideProvider>,
    );
    await flush();
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: Кафе");
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Новий пошук" }));
    expect(screen.queryByTestId("assistant-dialog")).toBeNull();
    expect(sessionStorage.getItem(DIALOG_KEY)).toBeNull();
  });
});

describe("dialog-store", () => {
  it("битая или чужая форма в хранилище — новый диалог", () => {
    sessionStorage.setItem(DIALOG_KEY, "{oops");
    expect(loadDialog()).toBeNull();
    sessionStorage.setItem(DIALOG_KEY, JSON.stringify({ v: 1, id: "x", turns: [{ text: 1 }] }));
    expect(loadDialog()).toBeNull();
    sessionStorage.setItem(
      DIALOG_KEY,
      JSON.stringify({ v: 1, id: "x", turns: [{ text: "кава", data: result() }] }),
    );
    expect(loadDialog()?.turns).toHaveLength(1);
  });

  it("поздний ответ прежнего экрана не попадает в новый диалог", async () => {
    let resolveOld: (r: AssistantResult) => void = () => undefined;
    const slow = fakeAssistant({
      ask: () =>
        new Promise<AssistantResult>((r) => {
          resolveOld = r;
        }),
    });
    const old = render(
      <GuideProvider value={env()}>
        <Assistant api={slow} initialQuery="стара" />
      </GuideProvider>,
    );
    old.unmount();
    // Новый запрос с главной — новый диалог.
    render(
      <GuideProvider value={env()}>
        <Assistant api={fakeAssistant()} initialQuery="нова" />
      </GuideProvider>,
    );
    await flush();
    await act(async () => resolveOld(result()));
    expect(loadDialog()?.turns.map((x) => x.text)).toEqual(["нова"]);
  });
});

describe("AssistantBox", () => {
  it("текст — onSubmit; без MediaRecorder (jsdom, iOS) кнопки микрофона нет", () => {
    const onSubmit = vi.fn();
    render(<AssistantBox api={fakeAssistant()} onSubmit={onSubmit} />);
    expect(screen.queryByTestId("assistant-mic")).toBeNull();
    const send = screen.getByRole("button", { name: "Знайти" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Що шукаєте?"), { target: { value: "  з дітьми " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).toHaveBeenCalledWith("з дітьми");
  });
});

describe("recordMime", () => {
  const md = { mediaDevices: { getUserMedia: () => undefined } };
  it("Opus в WebM/Ogg; только mp4 или нет MediaRecorder — голос недоступен", () => {
    expect(
      recordMime({ navigator: md, MediaRecorder: { isTypeSupported: (t) => t.startsWith("audio/webm") } }),
    ).toBe("audio/webm;codecs=opus");
    expect(
      recordMime({ navigator: md, MediaRecorder: { isTypeSupported: (t) => t === "audio/ogg;codecs=opus" } }),
    ).toBe("audio/ogg;codecs=opus");
    expect(
      recordMime({ navigator: md, MediaRecorder: { isTypeSupported: (t) => t === "audio/mp4" } }),
    ).toBeUndefined();
    expect(recordMime({ navigator: md })).toBeUndefined();
    expect(recordMime({ MediaRecorder: { isTypeSupported: () => true } })).toBeUndefined();
  });
});

describe("createAssistantApi", () => {
  const dto: ApiSchemas["AssistantResultDto"] = {
    intent: intent(),
    items: [
      {
        place: {
          id: "00000000-0000-4000-8000-000000000201",
          categoryId: CAFES,
          name: { uk: "Смерека" },
          address: null,
          location: { lon: 24.5, lat: 48.4 },
          distanceMeters: 120,
          recommended: false,
          adLabel: null,
          openNow: true,
          phone: null,
          cover: null,
          coverPhoto: null,
        },
        priceLevel: 2,
        kidsFriendly: false,
        description: "Опис",
        descriptionSource: "wikipedia",
        descriptionUrl: "javascript:alert(1)",
      },
    ],
    route: null,
    notes: ["no_origin"],
  };

  it("POST /assistant/query: регион, точка, контекст; javascript:-ссылка отбрасывается", async () => {
    const fetch = vi.fn(async (_req: Request) => Response.json(dto));
    const api = createAssistantApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
    const res = await api.ask({
      text: "дешевше",
      point: { lat: 48.4, lng: 24.5 },
      history: ["a", "b", "c", "d", "e", "f"],
      previous: intent(),
    });
    const req = fetch.mock.calls[0]![0];
    expect(new URL(req.url).pathname).toBe("/assistant/query");
    expect(await req.json()).toEqual({
      regionId: REGION,
      text: "дешевше",
      lat: 48.4,
      lng: 24.5,
      history: ["b", "c", "d", "e", "f"],
      previous: intent(),
    });
    expect(res.items[0]!.place.location).toEqual({ lat: 48.4, lng: 24.5 });
    expect(res.items[0]!.descriptionUrl).toBeNull();
    expect(res.notes).toEqual(["no_origin"]);
  });

  it("POST /assistant/transcribe: тело — запись, тип без кодека; 503 — ApiCallError с messageKey", async () => {
    const fetch = vi.fn(async (_req: Request) => Response.json({ text: " кава поруч " }));
    const api = createAssistantApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
    // Blob Node: Request (undici) в jsdom не читает Blob jsdom; в браузере — Blob записи MediaRecorder (E2E).
    const audio = new NodeBlob(["OggS"], { type: "audio/webm;codecs=opus" }) as unknown as Blob;
    expect(await api.transcribe(audio)).toBe("кава поруч");
    const req = fetch.mock.calls[0]![0];
    expect(req.url).toBe(`http://api.test/assistant/transcribe?regionId=${REGION}`);
    expect(req.headers.get("content-type")).toBe("audio/webm");
    expect(await req.text()).toBe("OggS");

    const failing = createAssistantApi(
      createApiClient({
        baseUrl: "http://api.test",
        fetch: async () =>
          Response.json(
            { error: { code: "SERVICE_UNAVAILABLE", messageKey: "errors.assistant.unavailable" } },
            { status: 503 },
          ),
      }),
      REGION,
    );
    const err = await failing.ask({ text: "x", history: [], previous: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).messageKey).toBe("errors.assistant.unavailable");
  });
});
