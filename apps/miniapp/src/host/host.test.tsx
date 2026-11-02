import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, noopGuideApi } from "../guide/context.js";
import { MyPlan, ScenarioScreen } from "../plan/MyPlan.js";
import { About } from "./About.js";
import { HostProvider, noopHostApi, type HostEnv } from "./context.js";
import { MyRequests, StaffRequests } from "./Requests.js";
import { ConflictError, type HostApi, type HostModule, type ServiceRequest } from "./types.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const PLACE = "00000000-0000-4000-8000-000000000201";

const module = (over: Partial<HostModule> = {}): HostModule => ({
  placeId: PLACE,
  name: { uk: "Тестовий готель" },
  rules: { uk: "Тиша після 22:00" },
  wifi: { ssid: "Hotel", password: "secret" },
  phone: "+380501234567",
  telegram: null,
  intake: { from: "08:00", to: "22:00" },
  acceptingNow: true,
  services: [{ id: "s1", title: { uk: "Прибирання" }, description: null, slaMinutes: 60 }],
  ...over,
});

const request = (over: Partial<ServiceRequest> = {}): ServiceRequest => ({
  id: "r1",
  placeId: PLACE,
  placeName: { uk: "Тестовий готель" },
  service: { uk: "Прибирання" },
  status: "new",
  comment: null,
  room: { value: "12", source: "guest" },
  createdAt: "2026-11-02T10:00:00Z",
  deferredUntil: null,
  overdue: false,
  ...over,
});

function setup(ui: React.ReactNode, api: Partial<HostApi>, env: Partial<HostEnv> = {}, signedIn = true) {
  const host: HostEnv = {
    api: { ...noopHostApi(), ...api },
    hotelPlaceId: PLACE,
    qrRoom: null,
    entryContextId: null,
    staff: false,
    ...env,
  };
  return render(
    <I18nProvider locale="uk">
      <GuideProvider
        value={{ api: noopGuideApi(), analytics: noopAnalytics, base: null, regionId: "r", signedIn }}
      >
        <HostProvider value={host}>{ui}</HostProvider>
      </GuideProvider>
    </I18nProvider>,
  );
}

describe("C03 Про заклад", () => {
  it("заявка: номер вводит гость, вне часов — «буде оброблено з …»", async () => {
    const createRequest = vi.fn(async () => request({ deferredUntil: "08:00" }));
    setup(<About />, { hostModule: async () => module({ acceptingNow: false }), createRequest });
    expect((await screen.findByTestId("intake-closed")).textContent).toContain("08:00");
    fireEvent.click(screen.getByRole("button", { name: "Замовити: Прибирання" }));
    fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" }));
    expect(screen.getByTestId("request-error").textContent).toContain("Вкажіть номер кімнати.");
    fireEvent.change(screen.getByLabelText("Номер кімнати"), { target: { value: " 12 " } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "s1", room: { value: "12", source: "guest" }, comment: null }),
    );
    expect(screen.getByTestId("request-sent").textContent).toContain("Її буде оброблено з 08:00");
  });

  it("номер из QR не спрашивается; 409 — дубль", async () => {
    const createRequest = vi.fn(async () => Promise.reject(new ConflictError()));
    setup(<About />, { hostModule: async () => module(), createRequest }, { qrRoom: "305" });
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    expect(screen.getByTestId("room-from-qr").textContent).toContain("305");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Надіслати заявку" })));
    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ room: { value: "305", source: "qr" } }),
    );
    expect(screen.getByTestId("request-error").textContent).toContain("Така заявка вже є");
  });

  it("без сессии — отправка требует входа", async () => {
    setup(<About />, { hostModule: async () => module() }, {}, false);
    fireEvent.click(await screen.findByRole("button", { name: "Замовити: Прибирання" }));
    expect(screen.getByTestId("request-login")).toBeTruthy();
  });
});

describe("заявки", () => {
  it("гость видит статус и пометку «вказано гостем»", async () => {
    setup(<MyRequests />, { myRequests: async () => [request({ status: "accepted" })] });
    expect((await screen.findByTestId("request-status")).textContent).toContain("Прийнята");
    expect(screen.getByTestId("request-room").textContent).toContain("Номер 12 (вказано гостем)");
  });

  it("персонал: смена статуса, 409 — сообщение и перезагрузка, просрочка", async () => {
    const staffRequests = vi.fn(async () => [request({ overdue: true })]);
    const setStatus = vi
      .fn<HostApi["setStatus"]>()
      .mockResolvedValueOnce(request({ status: "accepted" }))
      .mockRejectedValueOnce(new ConflictError());
    setup(<StaffRequests />, { staffRequests, setStatus }, { staff: true });
    expect(await screen.findByTestId("request-overdue")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Прийняти" })));
    expect(setStatus).toHaveBeenCalledWith("r1", "accepted");
    expect(screen.getByTestId("staff-message").textContent).toContain("Статус змінено: Прийнята");
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Відхилити" })));
    expect(screen.getByTestId("staff-message").textContent).toContain("Статус уже змінено");
    expect(staffRequests).toHaveBeenCalledTimes(3);
    fireEvent.change(screen.getByTestId("staff-filter"), { target: { value: "done" } });
    expect(staffRequests).toHaveBeenLastCalledWith("done");
  });

  it("без роли ORG_STAFF — нет доступа", () => {
    setup(<StaffRequests />, {});
    expect(screen.getByTestId("staff-forbidden")).toBeTruthy();
  });
});

describe("C09 Мій план", () => {
  const place = (id: string, name: string) => ({ id, name: { uk: name }, adLabel: null });
  it("список сценариев", async () => {
    setup(<MyPlan tab="scenarios" />, {
      scenarios: async () => [{ id: "sc1", title: { uk: "Один день" }, description: null, days: 1 }],
    });
    expect(await screen.findByRole("link", { name: "Один день" })).toBeTruthy();
  });

  it("замена и удаление пункта, сохранение плана", async () => {
    const savePlan = vi.fn<HostApi["savePlan"]>(async (scenarioId, title, schedule) => ({
      id: "p1",
      scenarioId,
      title,
      schedule,
      updatedAt: "",
    }));
    setup(<ScenarioScreen id="sc1" />, {
      scenario: async () => ({
        id: "sc1",
        title: { uk: "Один день" },
        description: null,
        days: 1,
        schedule: [
          {
            day: 1,
            items: [
              {
                id: "i1",
                time: "09:00",
                place: place("a", "Кав'ярня"),
                note: null,
                alternatives: [place("b", "Пекарня")],
              },
              { id: "i2", time: "11:00", place: place("c", "Музей"), note: null, alternatives: [] },
            ],
          },
        ],
      }),
      savePlan,
    });
    fireEvent.click((await screen.findAllByRole("button", { name: "Замінити" }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Замінити на: Пекарня" }));
    expect(screen.getByRole("link", { name: "Пекарня" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Видалити «Музей»" }));
    expect(screen.queryByRole("link", { name: "Музей" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Зберегти як план" })));
    const schedule = savePlan.mock.calls[0]![2];
    expect(schedule[0]!.items.map((i) => i.place.id)).toEqual(["b"]);
    expect(screen.getByTestId("plan-status").textContent).toContain("План збережено.");
    expect(screen.getByRole("button", { name: "Зберегти зміни" })).toBeTruthy();
  });
});
