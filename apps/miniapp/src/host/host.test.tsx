import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createApiClient } from "@tg/api-client";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, noopGuideApi } from "../guide/context.js";
import { MyPlan, SavedPlanScreen, ScenarioScreen } from "../plan/MyPlan.js";
import { About } from "./About.js";
import { HostProvider, noopHostApi, type HostEnv } from "./context.js";
import { createHostApi } from "./host-api.js";
import { MyRequests, StaffRequests } from "./Requests.js";
import {
  ApiCallError,
  ConflictError,
  NetworkError,
  type HostApi,
  type HostModule,
  type PlanDay,
  type ServiceRequest,
  type UserPlan,
} from "./types.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const PLACE = "00000000-0000-4000-8000-000000000201";

const module = (over: Partial<HostModule> = {}): HostModule => ({
  placeId: PLACE,
  name: { uk: "Тестовий готель" },
  sections: [{ kind: "rules", title: { uk: "Правила" }, content: { uk: "Тиша після 22:00" } }],
  wifi: { ssid: "Hotel", password: "secret" },
  phone: "+380501234567",
  intake: { from: "08:00", to: "22:00" },
  acceptingNow: true,
  room: null,
  services: [{ id: "cleaning", title: { uk: "Прибирання" }, description: null, slaMinutes: 60 }],
  ...over,
});

const request = (over: Partial<ServiceRequest> = {}): ServiceRequest => ({
  id: "r1",
  placeId: PLACE,
  placeName: { uk: "Тестовий готель" },
  service: { uk: "Прибирання" },
  status: "new",
  statusReason: null,
  comment: null,
  room: { value: "12", source: "guest" },
  createdAt: "2026-11-02T10:00:00Z",
  processFrom: null,
  overdue: false,
  cancellable: true,
  guestName: null,
  transitions: [],
  ...over,
});

function setup(
  ui: ReactNode,
  api: Partial<HostApi>,
  env: Partial<HostEnv> = {},
  signedIn = true,
  flags: Record<string, boolean> = { "module.host_requests": true },
) {
  const host: HostEnv = {
    api: { ...noopHostApi(), ...api },
    hotelPlaceId: PLACE,
    entryContextId: null,
    staff: "no",
    timeZone: "Europe/Kyiv",
    ...env,
  };
  return render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={flags}>
        <GuideProvider
          value={{ api: noopGuideApi(), analytics: noopAnalytics, base: null, regionId: "r", signedIn }}
        >
          <HostProvider value={host}>{ui}</HostProvider>
        </GuideProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
}

const text = (id: string) => screen.getByTestId(id).textContent ?? "";

describe("C03 Про заклад", () => {
  it("заявка: номер вводит гость, вне часов — «буде оброблено з …»", async () => {
    const createRequest = vi.fn(async () => request({ processFrom: "2026-11-03T06:00:00Z" }));
    setup(<About header={<h1>Готель</h1>} />, {
      hostModule: async () => module({ acceptingNow: false }),
      createRequest,
    });
    expect((await screen.findByTestId("intake-closed")).textContent).toContain("08:00");
    expect(screen.getByRole("heading", { name: "Правила" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Замовити: Прибирання" }));
    fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" }));
    expect(text("request-error")).toContain("Вкажіть номер кімнати.");
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: " 12 " } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "cleaning", roomLabel: "12", comment: null }),
    );
    expect(text("request-sent")).toContain("Її буде оброблено з");
  });

  it("номер из QR не спрашивается; 409 — дубль", async () => {
    const createRequest = vi.fn(async () => Promise.reject(new ConflictError()));
    setup(<About header={<h1>Готель</h1>} />, {
      hostModule: async () => module({ room: { value: "305", source: "qr" } }),
      createRequest,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    expect(text("room-from-qr")).toContain("305");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ roomLabel: null }));
    expect(text("request-error")).toContain("Така заявка вже є");
  });

  it("без сессии — отправка требует входа; модуль не настроен — пусто", async () => {
    setup(<About header={<h1>Готель</h1>} />, { hostModule: async () => module() }, {}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    expect(screen.getByTestId("request-login")).toBeTruthy();
    cleanup();
    setup(<About header={<h1>Готель</h1>} />, {}, { hotelPlaceId: null });
    expect(await screen.findByTestId("about-empty")).toBeTruthy();
  });
});

describe("C03: идемпотентность и флаг", () => {
  it("после сетевой ошибки поля заблокированы, повтор — тем же ключом; правка — новый ключ", async () => {
    const keys: string[] = [];
    const createRequest = vi
      .fn<HostApi["createRequest"]>(async (r) => {
        keys.push(r.idempotencyKey);
        return request();
      })
      .mockImplementationOnce(async (r) => {
        keys.push(r.idempotencyKey);
        throw new NetworkError();
      })
      .mockImplementationOnce(async (r) => {
        keys.push(r.idempotencyKey);
        throw new ConflictError("errors.idempotencyInProgress", "IDEMPOTENCY_IN_PROGRESS");
      });
    setup(<About header={<h1>Готель</h1>} />, { hostModule: async () => module(), createRequest });
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: "12" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(text("request-error")).toContain("дубля не буде");
    expect((screen.getByLabelText("Номер кімнати") as HTMLInputElement).readOnly).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Повторити" })));
    expect(text("request-error")).toContain("Заявка ще обробляється");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Повторити" })));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(screen.getByTestId("request-sent")).toBeTruthy();
  });

  it("правка полей меняет ключ; KEY_REUSED — понятное сообщение; серверный messageKey", async () => {
    const keys: string[] = [];
    const createRequest = vi
      .fn<HostApi["createRequest"]>()
      .mockImplementationOnce(async (r) => {
        keys.push(r.idempotencyKey);
        throw new NetworkError();
      })
      .mockImplementationOnce(async (r) => {
        keys.push(r.idempotencyKey);
        throw new ApiCallError(422, "errors.idempotencyKeyReused", "IDEMPOTENCY_KEY_REUSED");
      })
      .mockImplementationOnce(async (r) => {
        keys.push(r.idempotencyKey);
        throw new ApiCallError(422, "errors.serviceRequests.serviceUnavailable", "UNPROCESSABLE");
      });
    setup(<About header={<h1>Готель</h1>} />, { hostModule: async () => module(), createRequest });
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: "12" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    fireEvent.click(screen.getByRole("button", { name: "Змінити заявку" }));
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: "14" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(text("request-error")).toContain("Дані заявки змінилися");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(text("request-error")).toBe("Ця послуга зараз недоступна. Зверніться на рецепцію.");
    expect(new Set(keys).size).toBe(3);
  });

  it("окончательный 4xx (409) — следующая отправка с новым ключом", async () => {
    const keys: string[] = [];
    const createRequest = vi.fn<HostApi["createRequest"]>().mockImplementation(async (r) => {
      keys.push(r.idempotencyKey);
      throw new ApiCallError(409, "errors.unknown", "CONFLICT");
    });
    setup(<About header={<h1>Готель</h1>} />, { hostModule: async () => module(), createRequest });
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: "12" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("флаг module.host_requests выключен — услуг и «Мої заявки» нет", async () => {
    setup(<About header={<h1>Готель</h1>} />, { hostModule: async () => module() }, {}, true, {});
    expect(await screen.findByRole("heading", { name: "Правила" })).toBeTruthy();
    expect(screen.queryByTestId("services")).toBeNull();
    expect(screen.queryByTestId("my-requests-link")).toBeNull();
  });
});

describe("заявки", () => {
  it("гость видит статус, пометку «вказано гостем», может отменить", async () => {
    const cancelRequest = vi.fn(async () => request({ status: "cancelled_by_guest" }));
    setup(<MyRequests />, { myRequests: async () => [request({ status: "accepted" })], cancelRequest });
    expect((await screen.findByTestId("request-status")).textContent).toBe("Прийнята");
    expect(text("request-room")).toBe("Номер 12 (вказано гостем)");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Скасувати заявку" })));
    expect(cancelRequest).toHaveBeenCalledWith("r1");
    expect(text("requests-message")).toBe("Заявку скасовано.");
  });

  it("персонал: смена статуса, 409 — сообщение и перезагрузка, отклонение с причиной, просрочка", async () => {
    const staffRequests = vi.fn(async () => [
      request({ overdue: true, transitions: ["accepted", "rejected"] }),
    ]);
    const setStatus = vi
      .fn<HostApi["setStatus"]>()
      .mockResolvedValueOnce(request({ status: "accepted" }))
      .mockRejectedValueOnce(new ConflictError())
      .mockResolvedValueOnce(request({ status: "rejected" }));
    setup(<StaffRequests />, { staffRequests, setStatus }, { staff: "yes" });
    expect(await screen.findByTestId("request-overdue")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Прийняти" })));
    expect(setStatus).toHaveBeenCalledWith("r1", "accepted", null);
    expect(text("staff-message")).toBe("Статус змінено: Прийнята");
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Прийняти" })));
    expect(text("staff-message")).toContain("Статус уже змінено");
    expect(staffRequests).toHaveBeenCalledTimes(3);
    fireEvent.click(await screen.findByRole("button", { name: "Відхилити" }));
    fireEvent.change(screen.getByLabelText("Причина відхилення"), {
      target: { value: "Немає вільного персоналу" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Відхилити" })));
    expect(setStatus).toHaveBeenLastCalledWith("r1", "rejected", "Немає вільного персоналу");
    fireEvent.change(screen.getByTestId("staff-filter"), { target: { value: "done" } });
    expect(staffRequests).toHaveBeenLastCalledWith("done");
  });

  it("гость: 409 при отмене — свой текст", async () => {
    setup(<MyRequests />, {
      myRequests: async () => [request()],
      cancelRequest: async () => Promise.reject(new ConflictError()),
    });
    const cancel = await screen.findByRole("button", { name: "Скасувати заявку" });
    await act(async () => fireEvent.click(cancel));
    expect(text("requests-message")).toContain("скасувати не можна");
  });

  it("без роли персонала — нет доступа", () => {
    setup(<StaffRequests />, {});
    expect(screen.getByTestId("staff-forbidden")).toBeTruthy();
  });
});

describe("C09 Мій план", () => {
  const place = (id: string, name: string) => ({ id, name: { uk: name } });
  const days = (first: string): PlanDay[] => [
    {
      day: 1,
      items: [
        {
          id: "i1",
          time: "09:00",
          place: place(first, first === "a" ? "Кав'ярня" : "Пекарня"),
          note: null,
          alternatives: [place("b", "Пекарня")],
          distanceMeters: null,
          slot: "morning",
        },
        {
          id: "i2",
          time: "11:00",
          place: null,
          note: null,
          alternatives: [],
          distanceMeters: 1200,
          slot: "morning",
        },
      ],
    },
  ];
  const plan = (over: Partial<UserPlan> = {}): UserPlan => ({
    id: "00000000-0000-4000-8000-000000000901",
    scenarioId: "sc1",
    title: { uk: "Один день" },
    schedule: days("a"),
    scenarioUpdated: false,
    updatedAt: "",
    startDate: null,
    trip: { adults: 2, children: 0, withCar: true, days: 1 },
    base: null,
    options: [],
    ...over,
  });

  it("список сценариев; сценарий → «Зберегти як план» → переход к плану", async () => {
    setup(<MyPlan tab="scenarios" />, {
      scenarios: async () => [
        { id: "sc1", title: { uk: "Один день" }, description: null, days: 1, adLabel: null },
      ],
    });
    expect(await screen.findByRole("link", { name: "Один день" })).toBeTruthy();
    cleanup();
    const savePlan = vi.fn(async () => plan());
    setup(<ScenarioScreen id="sc1" />, {
      scenario: async () => ({
        id: "sc1",
        title: { uk: "Один день" },
        description: null,
        days: 1,
        adLabel: "partner",
        schedule: days("a"),
      }),
      savePlan,
    });
    expect(await screen.findByTestId("plan-item-unavailable")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Зберегти як план" })));
    expect(savePlan).toHaveBeenCalledWith("sc1");
    expect(window.location.hash).toBe(`#/plan/saved/${plan().id}`);
  });

  it("сохранённый план: замена и снятие галочки с пункта — PATCH", async () => {
    const updatePlan = vi
      .fn<HostApi["updatePlan"]>()
      .mockResolvedValueOnce(plan({ schedule: days("b") }))
      .mockResolvedValueOnce(plan({ schedule: [{ day: 1, items: [] }] }));
    setup(<SavedPlanScreen id={plan().id} />, { plan: async () => plan(), updatePlan });
    fireEvent.click(await screen.findByRole("button", { name: "Замінити: Кав'ярня" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Замінити на: Пекарня" })));
    expect(updatePlan).toHaveBeenCalledWith(plan().id, { replace: { itemId: "i1", placeId: "b" } });
    expect(screen.getByRole("checkbox", { name: "Пекарня" })).toBeTruthy();
    expect(text("plan-status")).toBe("Пункт замінено: Пекарня");
    await act(async () =>
      fireEvent.click(screen.getByRole("checkbox", { name: "Недоступно. Замініть пункт." })),
    );
    expect(updatePlan).toHaveBeenLastCalledWith(plan().id, { remove: "i2" });
    expect(screen.getAllByText("Ще нічого не обрано — позначте варіанти нижче.")).toHaveLength(4);
  });
});

describe("адаптер host-api", () => {
  it("POST /service-requests: Idempotency-Key, regionId; 409 → ConflictError", async () => {
    const calls: Request[] = [];
    const fetchMock = vi.fn(async (req: Request) => {
      calls.push(req);
      return new Response(
        JSON.stringify({ error: { code: "CONFLICT", messageKey: "errors.serviceRequests.duplicate" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    });
    const api = createHostApi(createApiClient({ baseUrl: "http://api", fetch: fetchMock }), "reg");
    await expect(
      api.createRequest({
        placeId: PLACE,
        serviceId: "cleaning",
        comment: null,
        roomLabel: "12",
        entryContextId: null,
        idempotencyKey: "k1",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(calls[0]!.headers.get("Idempotency-Key")).toBe("k1");
    expect(await calls[0]!.json()).toEqual({
      regionId: "reg",
      placeId: PLACE,
      serviceCode: "cleaning",
      roomLabel: "12",
    });
  });
});
