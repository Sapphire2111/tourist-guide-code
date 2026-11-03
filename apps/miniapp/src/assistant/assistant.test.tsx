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
import { HostProvider, noopHostApi, type HostEnv } from "../host/context.js";
import { takePlanPartial } from "../plan/partial-notice.js";
import { ApiCallError } from "../host/types.js";
import { FeatureFlagsProvider } from "@tg/ui";
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
import { AssistantSessionProvider } from "./session.js";
import { FROM_ASSISTANT } from "../back.js";

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
  plan: null,
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
              descriptionSource: "ai",
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
    fireEvent.change(screen.getByLabelText("Що додати або змінити?"), { target: { value: "кава" } });
    fireEvent.click(screen.getByRole("button", { name: "Надіслати" }));
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

describe("Assistant: переход в карточку", () => {
  it("ссылка на место из ответа — запись истории с меткой «из ассистента» (для «Назад»)", async () => {
    const api = fakeAssistant();
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="кав'ярня" />
      </GuideProvider>,
    );
    await flush();
    const link = screen
      .getAllByTestId("assistant-place")[0]!
      .querySelector<HTMLAnchorElement>("a[href^='#/']")!;
    fireEvent.click(link);
    expect(window.location.hash).toBe(link.getAttribute("href"));
    expect((window.history.state as Record<string, unknown>)[FROM_ASSISTANT]).toBe(true);
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
    const send = screen.getByRole("button", { name: "Надіслати" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Що шукаєте?"), { target: { value: "  з дітьми " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).toHaveBeenCalledWith("з дітьми");
  });

  it("пилюля: начальная — «Що шукаєте?» и чипы-примеры; уточнение — «Скажіть, що додати або змінити»", () => {
    const onSubmit = vi.fn();
    const start = render(<AssistantBox api={fakeAssistant()} onSubmit={onSubmit} examples />);
    expect((screen.getByLabelText("Що шукаєте?") as HTMLInputElement).placeholder).toBe(
      "Що шукаєте? Напишіть або скажіть…",
    );
    fireEvent.click(screen.getByRole("button", { name: "План на вихідні" }));
    expect(onSubmit).toHaveBeenCalledWith("План на вихідні");
    start.unmount();
    render(<AssistantBox api={fakeAssistant()} onSubmit={onSubmit} variant="refine" />);
    const input = screen.getByLabelText("Що додати або змінити?") as HTMLInputElement;
    expect(input.placeholder).toBe("Скажіть, що додати або змінити");
    expect(screen.queryByTestId("assistant-examples")).toBeNull();
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
    plan: null,
    notes: ["no_origin"],
    questions: [],
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

  it("план: пункт с индексом вне items отбрасывается; ответ без плана — null", async () => {
    const stop = (item: number) => ({
      item,
      role: "see" as const,
      start: "09:30",
      durationMin: 60,
      travel: null,
      travelMinutes: null,
      travelMeters: null,
      hours: null,
      note: null,
    });
    const withPlan = {
      ...dto,
      plan: {
        lengthMeters: 0,
        days: [{ dayNo: 1, date: "2026-11-07", parts: [{ part: "morning", stops: [stop(0), stop(5)] }] }],
      },
    };
    const fetch = vi.fn(async (_req: Request) => Response.json(withPlan));
    const api = createAssistantApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
    const res = await api.ask({ text: "план", history: [], previous: null });
    expect(res.plan!.days[0]!.parts[0]!.stops.map((s) => s.item)).toEqual([0]);
  });
});

describe("Assistant: больше мест и план", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      place: place(i + 1),
      priceLevel: null,
      kidsFriendly: false,
      description: null,
      descriptionSource: null,
      descriptionUrl: null,
    }));

  it("«Показати ще»: по 10 мест, кнопка пропадает, когда показаны все", async () => {
    const api = fakeAssistant({ ask: async () => result({ items: many(25) }) });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="суші" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("assistant-status").textContent).toBe("Знайдено в каталозі: 25");
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(10);
    // На карте — все найденные.
    expect(screen.getByTestId("map").getAttribute("data-n")).toBe("25");
    fireEvent.click(screen.getByTestId("assistant-more"));
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(20);
    fireEvent.click(screen.getByTestId("assistant-more"));
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(25);
    expect(screen.queryByTestId("assistant-more")).toBeNull();
  });

  it("ключевое слово — в сводке «что ищем»", async () => {
    const api = fakeAssistant({
      ask: async () => result({ intent: intent({ keywords: ["суші", "sushi"] }) }),
    });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="суші" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: «суші», Кафе");
  });

  const planResult = () =>
    result({
      intent: intent({ kind: "plan", categories: [], days: 2, withKids: true }),
      items: many(5),
      plan: {
        lengthMeters: 3200,
        days: [
          {
            dayNo: 1,
            date: "2026-11-07",
            parts: [
              {
                part: "morning",
                stops: [
                  {
                    item: 0,
                    role: "see",
                    start: "09:38",
                    durationMin: 90,
                    travel: "walk",
                    travelMinutes: 8,
                    travelMeters: 500,
                    hours: "09:00–18:00",
                    note: "Почніть день біля водоспаду.",
                  },
                ],
              },
              {
                part: "afternoon",
                stops: [
                  {
                    item: 1,
                    role: "eat",
                    start: "13:00",
                    durationMin: 75,
                    travel: "car",
                    travelMinutes: 10,
                    travelMeters: 2700,
                    hours: null,
                    note: null,
                  },
                ],
              },
            ],
          },
          {
            dayNo: 2,
            date: "2026-11-08",
            parts: [
              {
                part: "evening",
                stops: [2, 3, 4].map((item) => ({
                  item,
                  role: "relax" as const,
                  start: "19:00",
                  durationMin: 120,
                  travel: null,
                  travelMinutes: null,
                  travelMeters: null,
                  hours: null,
                  note: null,
                })),
              },
            ],
          },
        ],
      },
    });

  it("план: дни вкладками, части дня, время, роль, переезд, часы, пояснение; карта — места дня с маршрутом", async () => {
    const api = fakeAssistant({ ask: async () => planResult() });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="план на 2 дні з дітьми" />
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("assistant-reply").textContent).toBe("Шукаю: план відпочинку, з дітьми");
    const days = screen.getAllByTestId("assistant-plan-day");
    expect(days).toHaveLength(2);
    expect(days[0]!.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getAllByTestId("assistant-plan-part").map((p) => p.querySelector("h3")!.textContent),
    ).toEqual(["Ранок", "День"]);
    const stops = screen.getAllByTestId("assistant-plan-stop");
    expect(stops[0]!.textContent).toContain("09:38 · Огляд · ≈ 1 год 30 хв");
    expect(stops[0]!.textContent).toContain("≈ 8 хв пішки");
    expect(stops[0]!.textContent).toContain("Працює: 09:00–18:00");
    expect(stops[1]!.textContent).toContain("≈ 10 хв на авто");
    expect(screen.getByTestId("assistant-plan-note").textContent).toBe("Почніть день біля водоспаду.");
    // Пометки «ШІ» нет (SHOW_AI_LABELS = false).
    expect(document.body.textContent).not.toContain("ШІ");
    expect(screen.getByTestId("assistant-plan-length").textContent).toContain("3,2 км");
    const map = screen.getByTestId("map");
    expect([map.getAttribute("data-route"), map.getAttribute("data-n")]).toEqual(["true", "2"]);
    // Без «Мій план» (нет HostProvider и флага) — кнопки нет.
    expect(screen.queryByTestId("assistant-plan-add")).toBeNull();

    fireEvent.click(days[1]!);
    expect(screen.getAllByTestId("assistant-plan-stop")).toHaveLength(3);
    expect(screen.getByTestId("map").getAttribute("data-n")).toBe("3");
    expect(screen.getByTestId("assistant-plan-part").querySelector("h3")!.textContent).toBe("Вечір");
  });

  it("«Додати в Мій план»: новый план на дни ассистента, места — галочками по частям дня, затем экран плана", async () => {
    const api = fakeAssistant({ ask: async () => planResult() });
    const createPlan = vi.fn(async () => ({ id: "plan-1" }) as never);
    const updatePlan = vi.fn(async () => ({ id: "plan-1" }) as never);
    const host: HostEnv = {
      api: { ...noopHostApi(), createPlan, updatePlan },
      hotelPlaceId: null,
      entryContextId: null,
      staff: "no",
      timeZone: null,
    };
    render(
      <FeatureFlagsProvider flags={{ "module.host_requests": true }}>
        <HostProvider value={host}>
          <GuideProvider value={env()}>
            <Assistant api={api} initialQuery="план" />
          </GuideProvider>
        </HostProvider>
      </FeatureFlagsProvider>,
    );
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId("assistant-plan-add"));
    await flush();
    await flush();
    expect(createPlan).toHaveBeenCalledWith({
      adults: 2,
      children: 1,
      withCar: true,
      days: 2,
      startDate: "2026-11-07",
    });
    expect(updatePlan.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { add: { day: 1, slot: "morning", placeId: place(1).id } },
      { add: { day: 1, slot: "afternoon", placeId: place(2).id } },
      { add: { day: 2, slot: "evening", placeId: place(3).id } },
      { add: { day: 2, slot: "evening", placeId: place(4).id } },
      { add: { day: 2, slot: "evening", placeId: place(5).id } },
    ]);
    expect(window.location.hash).toBe("#/plan/saved/plan-1");
  });

  const renderWithHost = (createPlan: () => Promise<never>, updatePlan: () => Promise<never>) => {
    const host: HostEnv = {
      api: { ...noopHostApi(), createPlan, updatePlan },
      hotelPlaceId: null,
      entryContextId: null,
      staff: "no",
      timeZone: null,
    };
    render(
      <FeatureFlagsProvider flags={{ "module.host_requests": true }}>
        <HostProvider value={host}>
          <GuideProvider value={env()}>
            <Assistant api={fakeAssistant({ ask: async () => planResult() })} initialQuery="план" />
          </GuideProvider>
        </HostProvider>
      </FeatureFlagsProvider>,
    );
  };

  it("сбой после создания плана — открывается созданный (частичный) план, второй не создаётся", async () => {
    const createPlan = vi.fn(async () => ({ id: "plan-2" }) as never);
    let n = 0;
    const updatePlan = vi.fn(async () => {
      if (++n === 2) throw new ApiCallError(500, null);
      return { id: "plan-2" } as never;
    });
    renderWithHost(createPlan, updatePlan);
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId("assistant-plan-add"));
    await flush();
    await flush();
    expect(createPlan).toHaveBeenCalledTimes(1);
    expect(updatePlan).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe("#/plan/saved/plan-2");
    expect(screen.queryByRole("alert")).toBeNull();
    // Экран плана сообщит «Додано не все місця» один раз.
    expect(takePlanPartial("plan-2")).toBe(true);
    expect(takePlanPartial("plan-2")).toBe(false);
  });

  it("план не создан (сбой POST) — сообщение об ошибке, кнопку можно нажать снова", async () => {
    const createPlan = vi.fn(async () => {
      throw new ApiCallError(500, null);
    });
    renderWithHost(createPlan as never, vi.fn() as never);
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId("assistant-plan-add"));
    await flush();
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Не вдалося додати");
    expect((screen.getByTestId("assistant-plan-add") as HTMLButtonElement).disabled).toBe(false);
    expect(window.location.hash).not.toContain("/plan/saved/");
  });

  it("уточнение области и передвижения: чипы → следующая реплика с ответами в previous", async () => {
    const asked = result({
      intent: intent({ kind: "plan", categories: [], days: 5, withKids: true }),
      items: [],
      questions: ["scope", "transport"],
    });
    const api = fakeAssistant({ ask: vi.fn(async () => asked) });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="Я приїхав на 5 днів з дітьми, склади план" />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("assistant-status").textContent).toContain("Уточніть");
    const q = screen.getByTestId("assistant-questions");
    expect(q.textContent).toContain("Де плануєте відпочивати?");
    expect(q.textContent).toContain("Як пересуваєтесь?");
    // Точка — жильё туриста (нет пунктов рядом): «Тільки тут (Тестовий готель)».
    expect(screen.getByRole("button", { name: "Тільки тут (Тестовий готель)" })).toBeDefined();
    api.ask.mockResolvedValueOnce(planResult());
    fireEvent.click(screen.getByRole("button", { name: "По всьому Прикарпаттю" }));
    // Ответ на одно — ещё ждём второе.
    expect(api.ask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /На авто/ }));
    await flush();
    expect(api.ask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "По всьому Прикарпаттю, На авто",
        answer: true,
        previous: { ...asked.intent, scope: "region", scopeLocalityIds: [], transport: "car" },
      }),
    );
    expect(screen.queryByTestId("assistant-questions")).toBeNull();
    expect(screen.getAllByTestId("assistant-plan-stop").length).toBeGreaterThan(0);
  });

  it("план без авто: переезд в другой район — таксі каталога и подсказка про автобусы; значки 🚶/🚗", async () => {
    const base = planResult();
    const r = {
      ...base,
      intent: { ...base.intent, transport: "foot" as const },
      plan: {
        ...base.plan!,
        days: base.plan!.days.map((d, i) =>
          i === 1 ? { ...d, transfer: { meters: 14_000, taxi: [4], excursions: [], busStations: [] } } : d,
        ),
      },
    };
    const api = fakeAssistant({ ask: async () => r });
    render(
      <GuideProvider value={env()}>
        <Assistant api={api} initialQuery="план без машини" />
      </GuideProvider>,
    );
    await flush();
    const travel = screen.getAllByTestId("assistant-plan-travel").map((x) => x.textContent);
    expect(travel[0]).toContain("🚶");
    expect(travel[1]).toContain("🚗");
    expect(screen.queryByTestId("assistant-plan-transfer")).toBeNull();
    fireEvent.click(screen.getAllByTestId("assistant-plan-day")[1]!);
    const transfer = screen.getByTestId("assistant-plan-transfer");
    expect(transfer.textContent).toContain("14 км");
    expect(transfer.textContent).toContain("Таксі й трансфер поруч");
    expect(transfer.textContent).toContain("Місце 5");
    expect(screen.getByTestId("assistant-bus-hint").textContent).toBe(
      "Розклад автобусів уточнюйте на автостанції / у перевізника.",
    );
  });

  it("«Назад» из карточки: провайдер выше маршрутов — тот же ответ, «Показати ще», день плана и прокрутка", async () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    const api = fakeAssistant({ ask: async () => result({ items: many(25) }) });
    const Screen = ({ show }: { show: boolean }) => (
      <GuideProvider value={env()}>
        <AssistantSessionProvider>
          {show ? <Assistant api={api} initialQuery={""} /> : <p>картка місця</p>}
        </AssistantSessionProvider>
      </GuideProvider>
    );
    const view = render(<Screen show />);
    fireEvent.change(screen.getByLabelText("Що шукаєте?"), { target: { value: "кафе" } });
    fireEvent.click(screen.getByRole("button", { name: "Надіслати" }));
    await flush();
    fireEvent.click(screen.getByTestId("assistant-more"));
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(20);
    Object.defineProperty(window, "scrollY", { value: 900, configurable: true });
    fireEvent.scroll(window);
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    // Переход в карточку места: экран ассистента снят, провайдер остался.
    view.rerender(<Screen show={false} />);
    expect(screen.queryByTestId("assistant-dialog")).toBeNull();
    view.rerender(<Screen show />);
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("assistant-place")).toHaveLength(20);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 900 }));
    // Строка ввода одна — уточнения под ответом.
    expect(screen.getAllByTestId("assistant-box")).toHaveLength(1);
    expect(screen.getByLabelText("Що додати або змінити?")).toBeDefined();
    // И в хранилище (перезагрузка вкладки): раскрыто 20, прокрутка 900.
    expect(loadDialog()?.ui).toMatchObject({ shown: 20, scrollY: 900 });
  });
});
