import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { ApiCallError, ConflictError } from "../host/types.js";
import { noopPartnerApi, PartnerProvider, resolveSelection } from "./context.js";
import { PartnerDashboard } from "./Dashboard.js";
import { AcceptInvite } from "./Invite.js";
import { dayOf, offerInput, PartnerOffers, safeTimeZone } from "./Offers.js";
import { PartnerOnboarding } from "./Onboarding.js";
import { createApiClient } from "@tg/api-client";
import { NetworkError } from "../host/types.js";
import {
  createPartnerApi,
  inviteTokenOf,
  keepsIdempotencyKey,
  UploadRejectedError,
  type PartnerApi,
  type PartnerOrganization,
  type PartnerPlace,
} from "./partner-api.js";
import { patchOf, PlaceEditor, scheduleOf } from "./PlaceEditor.js";
import { PartnerStaff } from "./Staff.js";
import { PartnerHeader } from "./parts.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const ORG = "00000000-0000-4000-8000-00000000a001";
const PLACE = "00000000-0000-4000-8000-00000000b001";
const CAT = "00000000-0000-4000-8000-00000000c001";
const TOKEN = "A".repeat(43);

const abilities = (owner: boolean) => ({
  editPlace: true,
  editIdentity: owner,
  submit: owner,
  manageStaff: owner,
  manageOffers: true,
  managePriceList: true,
  serviceRequests: true,
  bookings: true,
  manualBooking: true,
  manageResources: true,
  editAvailability: true,
  manualAvailability: true,
  customerPhone: true,
});

const org = (over: Partial<PartnerOrganization> = {}): PartnerOrganization => ({
  id: ORG,
  regionId: "r1",
  name: "ТОВ Смерека",
  role: "ORG_OWNER",
  assignmentId: "as1",
  abilities: abilities(true),
  places: [
    {
      id: PLACE,
      name: { uk: "Садиба Смерека" },
      status: "changes_requested",
      templateCode: "hotel",
      modules: ["host_requests", "offers"],
      moderation: {
        caseId: "c1",
        status: "decided",
        decision: "changes_requested",
        comment: "Додайте фото фасаду",
        submittedAt: "2026-11-01T10:00:00Z",
        decidedAt: "2026-11-01T12:00:00Z",
      },
      openServiceRequests: 2,
      activeOffers: 1,
    },
  ],
  ...over,
});

const place = (over: Partial<PartnerPlace> = {}): PartnerPlace => ({
  id: PLACE,
  organizationId: ORG,
  regionId: "r1",
  status: "draft",
  template: {
    code: "hotel",
    name: { uk: "Готель / садиба" },
    requiredFields: ["name", "photo"],
    modules: ["offers"],
    categories: [{ id: CAT, code: "hotels", name: { uk: "Готелі" } }],
  },
  role: "ORG_OWNER",
  abilities: abilities(true),
  editable: true,
  categoryId: CAT,
  localityId: null,
  name: { uk: "Садиба Смерека" },
  description: null,
  address: { uk: "Косів, вул. Ринкова, 1" },
  location: { lon: 25.1, lat: 48.3 },
  phone: null,
  website: null,
  telegram: null,
  tagIds: [],
  schedule: {
    timezone: "Europe/Kyiv",
    weekly: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }],
    exceptions: [{ date: "2026-12-31", closed: true, opensAt: null, closesAt: null, note: null }],
  },
  media: [],
  mediaPreview: {},
  missingFields: ["photo"],
  moderation: null,
  updatedAt: "2026-11-02T00:00:00Z",
  ...over,
});

function setup(ui: ReactNode, api: Partial<PartnerApi>, flags: Record<string, boolean> = {}) {
  const full = { ...noopPartnerApi(), ...api } as PartnerApi;
  // Proxy noopPartnerApi не копируется spread-ом: недостающие методы — отказ.
  const merged = new Proxy(full, {
    get: (target, key: string) =>
      (api as Record<string, unknown>)[key] ?? (() => Promise.reject(new Error("no api"))),
  });
  return render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider
        flags={{ "module.partner_cabinet": true, "module.host_requests": true, ...flags }}
      >
        <PartnerProvider api={merged} regionId="r1" enabled>
          {ui}
        </PartnerProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
}

describe("правила кабинета", () => {
  it("токен приглашения из start_param inv_<токен>", () => {
    expect(inviteTokenOf(`inv_${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenOf(TOKEN)).toBeUndefined();
    expect(inviteTokenOf("inv_short")).toBe("short");
    expect(inviteTokenOf("demoHotel01")).toBeUndefined();
    expect(inviteTokenOf(undefined)).toBeUndefined();
  });

  it("PATCH — только изменённые поля; поля личности без права не отправляются", () => {
    const p = place();
    const form = {
      name: "Нова назва",
      categoryId: CAT,
      address: "Косів, вул. Ринкова, 1",
      lat: "48.3",
      lon: "25.1",
      description: "Опис",
      phone: "+380501112233",
      website: "",
      telegram: "@smereka",
    };
    expect(patchOf(p, form, true)).toEqual({
      name: { uk: "Нова назва" },
      description: { uk: "Опис" },
      phone: "+380501112233",
      telegram: "smereka",
    });
    expect(patchOf(p, form, false)).toEqual({
      description: { uk: "Опис" },
      phone: "+380501112233",
      telegram: "smereka",
    });
    expect(patchOf(p, { ...form, lat: "abc" }, true)).toBe("bad_location");
    expect(patchOf(p, { ...form, lat: "", lon: "" }, true)).toMatchObject({ location: null });
  });

  it("график: недельные интервалы из формы, исключения сохраняются", () => {
    expect(scheduleOf(place(), [{ dayOfWeek: 2, opensAt: "10:00", closesAt: "02:00" }])).toEqual({
      weekly: [{ dayOfWeek: 2, opensAt: "10:00", closesAt: "02:00" }],
      exceptions: [{ date: "2026-12-31", closed: true }],
    });
  });

  it("акция: период — конец позже начала", () => {
    expect(offerInput({ title: " Знижка ", description: "", startsAt: "2026-11-10", endsAt: "" })).toEqual({
      title: { uk: "Знижка" },
      description: null,
      // Начало дня по Києву (UTC+2 у листопаді).
      startsAt: "2026-11-09T22:00:00.000Z",
      endsAt: null,
    });
    // «До 10.11 включно» по Києву — 23:59:59 за київським часом; влітку UTC+3.
    expect(offerInput({ title: "x", description: "", startsAt: "", endsAt: "2026-11-10" })?.endsAt).toBe(
      "2026-11-10T21:59:59.000Z",
    );
    expect(offerInput({ title: "x", description: "", startsAt: "2026-07-01", endsAt: "" })?.startsAt).toBe(
      "2026-06-30T21:00:00.000Z",
    );
    expect(dayOf("2026-11-10T21:59:59.000Z")).toBe("2026-11-10");
    expect(dayOf("2026-11-09T22:00:00.000Z")).toBe("2026-11-10");
    expect(
      offerInput({ title: "x", description: "", startsAt: "2026-11-10", endsAt: "2026-11-10" }),
    ).not.toBeNull();
    expect(
      offerInput({ title: "x", description: "", startsAt: "2026-11-10", endsAt: "2026-11-09" }),
    ).toBeNull();
  });

  it("выбор организации/заведения: сохранённый, иначе первые", () => {
    const o = org();
    expect(resolveSelection([o], { orgId: null, placeId: null }).place?.id).toBe(PLACE);
    expect(resolveSelection([], { orgId: null, placeId: null })).toEqual({ org: null, place: null });
  });
});

describe("P01/P13 дашборд", () => {
  it("не партнёр — «Стати партнером»", async () => {
    setup(<PartnerDashboard />, { me: () => Promise.resolve({ organizations: [] }) });
    expect(await screen.findByTestId("not-partner")).toBeDefined();
    expect(screen.getByRole("link", { name: "Стати партнером" }).getAttribute("href")).toBe("#/partner/new");
  });

  it("владелец: статус, комментарий модератора, ссылки P06/P07/P09/P10", async () => {
    setup(<PartnerDashboard />, { me: () => Promise.resolve({ organizations: [org()] }) });
    expect((await screen.findByTestId("place-status")).textContent).toBe("Потрібні правки");
    expect(screen.getByTestId("moderator-comment").textContent).toContain("Додайте фото фасаду");
    expect(screen.getByRole("link", { name: "Редагувати заклад" }).getAttribute("href")).toBe(
      `#/partner/place/${PLACE}`,
    );
    expect(screen.getByRole("link", { name: "Акції (діють: 1)" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Співробітники" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Заявки гостей (відкриті: 2)" })).toBeDefined();
    expect(screen.getByTestId("mode-switch")).toBeDefined();
  });

  it("менеджер: без сотрудников; модуль заявок выключен — без ссылки на заявки", async () => {
    setup(
      <PartnerDashboard />,
      {
        me: () =>
          Promise.resolve({ organizations: [org({ role: "ORG_MANAGER", abilities: abilities(false) })] }),
      },
      { "module.host_requests": false },
    );
    expect(await screen.findByRole("link", { name: "Редагувати заклад" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Співробітники" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Заявки гостей/ })).toBeNull();
  });
});

describe("P06 редактор", () => {
  it("менеджер: поля личности заблокированы, отправки нет", async () => {
    setup(<PlaceEditor id={PLACE} />, {
      place: () => Promise.resolve(place({ role: "ORG_MANAGER", abilities: abilities(false) })),
    });
    expect((await screen.findByTestId("identity-locked")).textContent).toBe(
      "Назву, категорію, адресу й точку змінює власник закладу.",
    );
    expect((screen.getByLabelText("Назва") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Опис") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByText("На модерацію надсилає власник закладу.")).toBeDefined();
  });

  it("сохранение: 409 опубликованного — понятное сообщение", async () => {
    const updatePlace = vi.fn(() =>
      Promise.reject(new ConflictError("errors.partner.identityChangeRequiresModeration")),
    );
    setup(<PlaceEditor id={PLACE} />, {
      place: () => Promise.resolve(place({ status: "published" })),
      updatePlace,
    });
    fireEvent.change(await screen.findByLabelText("Опис"), { target: { value: "Новий опис" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Зберегти" }));
    });
    expect(updatePlace).toHaveBeenCalledWith(PLACE, { description: { uk: "Новий опис" } });
    expect(screen.getByTestId("editor-message").textContent).toContain("адміністратор");
  });

  it("отправка на модерацию: 422 с missingFields — список полей", async () => {
    const submit = vi.fn(() =>
      Promise.reject(
        new ApiCallError(422, "errors.partner.requiredFieldsMissing", "UNPROCESSABLE", {
          missingFields: ["photo", "schedule"],
        }),
      ),
    );
    setup(<PlaceEditor id={PLACE} />, { place: () => Promise.resolve(place({ missingFields: [] })), submit });
    fireEvent.click(await screen.findByLabelText("Погоджуюся з умовами для партнерів"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Надіслати на перевірку" }));
    });
    expect(screen.getByTestId("missing-fields").textContent).toBe(
      "Щоб надіслати на перевірку, додайте: Фото, Графік роботи.",
    );
    expect(screen.getByTestId("submit-message").textContent).toContain("Заповніть обов'язкові поля");
  });

  it("на модерации — только чтение", async () => {
    setup(<PlaceEditor id={PLACE} />, {
      place: () => Promise.resolve(place({ status: "pending_moderation", editable: false })),
    });
    expect(await screen.findByTestId("editor-readonly")).toBeDefined();
    expect(screen.getByText("Заклад на перевірці в модератора.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Надіслати на перевірку" })).toBeNull();
  });
});

describe("P09 и P14", () => {
  it("сотрудники: приглашение — ссылка t.me с копированием", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const link = `https://t.me/test_bot?startapp=inv_${TOKEN}`;
    setup(<PartnerStaff orgId={ORG} />, {
      me: () => Promise.resolve({ organizations: [org()] }),
      staff: () => Promise.resolve({ members: [], invites: [] }),
      invite: () =>
        Promise.resolve({
          invite: {
            id: "i1",
            role: "ORG_STAFF",
            state: "active",
            expiresAt: "2026-11-05T00:00:00Z",
            createdAt: "2026-11-02T00:00:00Z",
            acceptedAt: null,
            acceptedByName: null,
          },
          token: TOKEN,
          startParam: `inv_${TOKEN}`,
          link,
        }),
    });
    const inviteButton = await screen.findByRole("button", { name: "Запросити працівника" });
    await act(async () => {
      fireEvent.click(inviteButton);
    });
    expect(screen.getByTestId("invite-link").textContent).toBe(link);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Скопіювати посилання" }));
    });
    expect(writeText).toHaveBeenCalledWith(link);
  });

  it("сотрудники: без права — отказ", async () => {
    setup(<PartnerStaff orgId={ORG} />, {
      me: () => Promise.resolve({ organizations: [org({ role: "ORG_STAFF", abilities: abilities(false) })] }),
    });
    expect((await screen.findByRole("alert")).textContent).toBe("Співробітниками керує власник закладу.");
  });

  it("приглашение: «Прийняти» → кабинет", async () => {
    const acceptInvite = vi.fn(() =>
      Promise.resolve({
        organizationId: ORG,
        regionId: "r1",
        role: "ORG_STAFF" as const,
        assignmentId: "a2",
      }),
    );
    setup(<AcceptInvite token={TOKEN} />, {
      me: () => Promise.resolve({ organizations: [] }),
      invitePreview: () =>
        Promise.resolve({
          organizationName: "ТОВ Смерека",
          placeNames: [{ uk: "Садиба Смерека" }],
          role: "ORG_STAFF",
          state: "active",
          expiresAt: "2026-11-05T00:00:00Z",
          alreadyMember: false,
        }),
      acceptInvite,
    });
    expect((await screen.findByTestId("invite-preview")).textContent).toContain(
      "Вас запрошено як працівник до «ТОВ Смерека».",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Прийняти" }));
    });
    expect(acceptInvite).toHaveBeenCalledWith(TOKEN);
    expect(window.location.hash).toBe("#/partner");
  });

  it("приглашение истекло — сообщение, без кнопки", async () => {
    setup(<AcceptInvite token={TOKEN} />, {
      invitePreview: () =>
        Promise.resolve({
          organizationName: "ТОВ Смерека",
          placeNames: [],
          role: "ORG_MANAGER",
          state: "expired",
          expiresAt: "2026-11-01T00:00:00Z",
          alreadyMember: false,
        }),
    });
    expect(await screen.findByText("Запрошення втратило чинність. Попросіть нове.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Прийняти" })).toBeNull();
  });
});

describe("исправления ревью", () => {
  it("онбординг: после 4xx — новый ключ идемпотентности, после сети — тот же; правка формы — новый", async () => {
    const keys: string[] = [];
    const errors: unknown[] = [
      new ApiCallError(422, "errors.partner.categoryNotInTemplate", "UNPROCESSABLE"),
      new NetworkError(),
    ];
    const onboard = vi.fn((_: unknown, key: string) => {
      keys.push(key);
      const err = errors.shift();
      return err ? Promise.reject(err) : Promise.resolve(place());
    });
    setup(<PartnerOnboarding />, {
      me: () => Promise.resolve({ organizations: [] }),
      templates: () =>
        Promise.resolve([
          {
            id: "t1",
            code: "hotel",
            name: { uk: "Готель / садиба" },
            description: null,
            requiredFields: [],
            modules: [],
            categories: [{ id: CAT, code: "hotels", name: { uk: "Готелі" } }],
          },
        ]),
      onboard,
    });
    fireEvent.click(await screen.findByLabelText("Готель / садиба"));
    fireEvent.change(screen.getByLabelText("Назва закладу"), { target: { value: "Смерека" } });
    const create = () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Створити заклад" }));
      });
    await create();
    await create();
    await create();
    expect(keys[1]).not.toBe(keys[0]); // 422 сохранён сервером — новый ключ
    expect(keys[2]).toBe(keys[1]); // сеть — исход неизвестен, тот же ключ
    expect(keepsIdempotencyKey(new ConflictError(null, "IDEMPOTENCY_IN_PROGRESS"))).toBe(true);
    expect(keepsIdempotencyKey(new ApiCallError(503, null))).toBe(true);
    expect(keepsIdempotencyKey(new ApiCallError(400, null))).toBe(false);
  });

  it("редактор: сохранение графика (новый updatedAt) не теряет несохранённую правку основной формы", async () => {
    let version = 0;
    const loadPlace = vi.fn(() => Promise.resolve(place({ updatedAt: `2026-11-02T00:00:0${version}Z` })));
    const putSchedule = vi.fn(() => {
      version += 1;
      return Promise.resolve();
    });
    const updatePlace = vi.fn(() => {
      version += 1;
      return Promise.resolve(
        place({ description: { uk: "Опис" }, updatedAt: `2026-11-02T00:00:0${version}Z` }),
      );
    });
    setup(<PlaceEditor id={PLACE} />, { place: loadPlace, putSchedule, updatePlace });
    fireEvent.change(await screen.findByLabelText("Опис"), { target: { value: "Опис" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Зберегти графік" }));
    });
    expect(loadPlace).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText("Опис") as HTMLTextAreaElement).value).toBe("Опис");
    expect(screen.getByTestId("schedule-message").textContent).toBe("Графік збережено.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    });
    expect(updatePlace).toHaveBeenCalledWith(PLACE, { description: { uk: "Опис" } });
    expect(screen.getByTestId("schedule-message").textContent).toBe("Графік збережено.");
    expect(screen.getByTestId("editor-message").textContent).toBe("Зміни збережено.");
  });

  it("редактор: пустое название — сообщение, без запроса", async () => {
    const updatePlace = vi.fn();
    setup(<PlaceEditor id={PLACE} />, { place: () => Promise.resolve(place()), updatePlace });
    fireEvent.change(await screen.findByLabelText("Назва"), { target: { value: " " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Зберегти$/ }));
    });
    expect(updatePlace).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-message").textContent).toBe("Назва обов'язкова.");
  });

  describe("uploadPhoto", () => {
    const fakeClient = (confirmStatus: number) =>
      createApiClient({
        baseUrl: "http://api.test",
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path.endsWith("/media/uploads"))
            return Response.json(
              {
                asset: { id: "00000000-0000-4000-8000-00000000e001" },
                upload: {
                  url: "https://upload.test/x",
                  method: "PUT",
                  headers: { "x-sig": "1" },
                  expiresAt: "2099-01-01T00:00:00Z",
                },
              },
              { status: 201 },
            );
          if (path.endsWith("/confirm"))
            return confirmStatus < 300
              ? Response.json({}, { status: confirmStatus })
              : Response.json(
                  { error: { code: "UNPROCESSABLE", messageKey: "errors.place.mediaInvalid" } },
                  { status: confirmStatus },
                );
          return Response.json({}, { status: 404 });
        },
      });
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    afterEach(() => vi.unstubAllGlobals());

    it("PUT по подписанной ссылке с заголовками, затем confirm", async () => {
      const put = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", put);
      await createPartnerApi(fakeClient(201)).uploadPhoto(PLACE, file, "Фасад");
      expect(put).toHaveBeenCalledWith(
        "https://upload.test/x",
        expect.objectContaining({ method: "PUT", headers: { "x-sig": "1" } }),
      );
    });

    it("PUT отклонён (403 — истёкшая подпись) — UploadRejectedError, не сетевая", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 403 })),
      );
      await expect(createPartnerApi(fakeClient(201)).uploadPhoto(PLACE, file, "")).rejects.toBeInstanceOf(
        UploadRejectedError,
      );
    });

    it("confirm 422 — ошибка с messageKey сервера", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 200 })),
      );
      await expect(createPartnerApi(fakeClient(422)).uploadPhoto(PLACE, file, "")).rejects.toMatchObject({
        status: 422,
        messageKey: "errors.place.mediaInvalid",
      });
    });
  });

  it("P07: создание с границами дня по Києву, правка, архив с подтверждением", async () => {
    const offer = {
      id: "o1",
      placeId: PLACE,
      title: { uk: "Знижка 10%" },
      description: null,
      startsAt: null,
      endsAt: "2026-11-10T21:59:59.000Z",
      status: "active" as const,
      createdAt: "2026-11-02T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
    };
    const createOffer = vi.fn(() => Promise.resolve(offer));
    const updateOffer = vi.fn(() => Promise.resolve(offer));
    const archiveOffer = vi.fn(() => Promise.resolve({ ...offer, status: "archived" as const }));
    setup(<PartnerOffers placeId={PLACE} />, {
      me: () => Promise.resolve({ organizations: [org()] }),
      offers: () => Promise.resolve([offer]),
      createOffer,
      updateOffer,
      archiveOffer,
    });
    // Показ «до» — день по Києву, не следующий.
    expect((await screen.findByTestId("offer-item")).textContent).toContain("до 10.11.2026");
    fireEvent.change(screen.getByLabelText("Назва акції"), { target: { value: "Чан у подарунок" } });
    fireEvent.change(screen.getByLabelText("Кінець (необов'язково)"), { target: { value: "2026-11-10" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Створити акцію" }));
    });
    expect(createOffer).toHaveBeenCalledWith(PLACE, {
      title: { uk: "Чан у подарунок" },
      description: null,
      startsAt: null,
      endsAt: "2026-11-10T21:59:59.000Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "Змінити: Знижка 10%" }));
    expect((screen.getByLabelText("Кінець (необов'язково)") as HTMLInputElement).value).toBe("2026-11-10");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Зберегти акцію" }));
    });
    expect(updateOffer).toHaveBeenCalledWith(
      PLACE,
      "o1",
      expect.objectContaining({ endsAt: "2026-11-10T21:59:59.000Z" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "До архіву: Знижка 10%" }));
    expect(archiveOffer).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Так, до архіву" }));
    });
    expect(archiveOffer).toHaveBeenCalledWith(PLACE, "o1");
  });

  it("P09: роль меняется только кнопкой «Змінити роль»", async () => {
    const changeRole = vi.fn(() => Promise.resolve());
    setup(<PartnerStaff orgId={ORG} />, {
      me: () => Promise.resolve({ organizations: [org()] }),
      staff: () =>
        Promise.resolve({
          members: [
            {
              assignmentId: "a9",
              userId: "u9",
              displayName: "Олена",
              username: null,
              role: "ORG_STAFF",
              grantedAt: "2026-11-01T00:00:00Z",
              isMe: false,
            },
          ],
          invites: [],
        }),
      changeRole,
    });
    fireEvent.change(await screen.findByLabelText("Роль: Олена"), { target: { value: "ORG_MANAGER" } });
    expect(changeRole).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Змінити роль" }));
    });
    expect(changeRole).toHaveBeenCalledWith(ORG, "a9", "ORG_MANAGER");
  });

  it("дашборд: «Створити ще одну організацію» — только владельцу", async () => {
    setup(<PartnerDashboard />, {
      me: () => Promise.resolve({ organizations: [org({ role: "ORG_STAFF", abilities: abilities(false) })] }),
    });
    expect(await screen.findByTestId("partner-org")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Створити ще одну організацію" })).toBeNull();
  });

  it("часовой пояс: запасной Europe/Kiev для старых ICU; дни перехода на летнее/зимнее время", () => {
    expect(safeTimeZone("No/Such_Zone")).toBe("Europe/Kiev");
    const d = (startsAt: string, endsAt: string) =>
      offerInput({ title: "x", description: "", startsAt, endsAt });
    // 29.03.2026: 03:00 → 04:00 (UTC+2 → UTC+3).
    expect(d("2026-03-29", "2026-03-29")).toMatchObject({
      startsAt: "2026-03-28T22:00:00.000Z",
      endsAt: "2026-03-29T20:59:59.000Z",
    });
    // 25.10.2026: 04:00 → 03:00 (UTC+3 → UTC+2).
    expect(d("2026-10-25", "2026-10-25")).toMatchObject({
      startsAt: "2026-10-24T21:00:00.000Z",
      endsAt: "2026-10-25T21:59:59.000Z",
    });
    expect(dayOf("2026-03-28T22:00:00.000Z")).toBe("2026-03-29");
    expect(dayOf("2026-03-29T20:59:59.000Z")).toBe("2026-03-29");
    expect(dayOf("2026-10-24T21:00:00.000Z")).toBe("2026-10-25");
    expect(dayOf("2026-10-25T21:59:59.000Z")).toBe("2026-10-25");
    expect(keepsIdempotencyKey(new ApiCallError(408, null))).toBe(true);
  });

  it("приглашение: уже сотрудник — переход в кабинет с сообщением", async () => {
    setup(
      <>
        <AcceptInvite token={TOKEN} />
        <PartnerDashboard />
      </>,
      {
        me: () =>
          Promise.resolve({ organizations: [org({ role: "ORG_STAFF", abilities: abilities(false) })] }),
        invitePreview: () =>
          Promise.resolve({
            organizationName: "ТОВ Смерека",
            placeNames: [],
            role: "ORG_STAFF",
            state: "active",
            expiresAt: "2026-11-05T00:00:00Z",
            alreadyMember: false,
          }),
        acceptInvite: () => Promise.reject(new ConflictError("errors.staffInvite.alreadyMember")),
      },
    );
    const accept = await screen.findByRole("button", { name: "Прийняти" });
    await act(async () => {
      fireEvent.click(accept);
    });
    expect(window.location.hash).toBe("#/partner");
    expect(screen.getByTestId("partner-notice").textContent).toBe("Ви вже працюєте в цьому закладі.");
  });
});

describe("PartnerHeader", () => {
  const withTelegram = (native: boolean) => {
    (window as unknown as { Telegram?: unknown }).Telegram = native
      ? { WebApp: { platform: "android", BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} } } }
      : undefined;
  };
  afterEach(() => withTelegram(false));

  it("в браузере — ссылка «← Мій заклад» и h1", () => {
    withTelegram(false);
    setup(<PartnerHeader title="Співробітники" />, {});
    expect(screen.getByRole("heading", { level: 1, name: "Співробітники" })).toBeDefined();
    expect(screen.getByRole("link", { name: "← Мій заклад" }).getAttribute("href")).toBe("#/partner");
  });

  it("в Telegram с BackButton ссылки нет", () => {
    withTelegram(true);
    setup(<PartnerHeader title="Співробітники" />, {});
    expect(screen.queryByRole("link", { name: "← Мій заклад" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Співробітники" })).toBeDefined();
  });
});

describe("Staff: отзыв приглашения", () => {
  it("сначала подтверждение, запрос — только после «Так, відкликати»", async () => {
    const revokeInvite = vi.fn(() => Promise.resolve());
    setup(<PartnerStaff orgId={ORG} />, {
      me: () => Promise.resolve({ organizations: [org()] }),
      staff: () =>
        Promise.resolve({
          members: [],
          invites: [
            {
              id: "i1",
              role: "ORG_STAFF",
              state: "active",
              expiresAt: "2026-11-05T00:00:00Z",
              createdAt: "2026-11-02T00:00:00Z",
              acceptedAt: null,
              acceptedByName: null,
            },
          ],
        }),
      revokeInvite,
    } as Partial<PartnerApi>);
    fireEvent.click(await screen.findByRole("button", { name: "Відкликати запрошення" }));
    expect(revokeInvite).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Так, відкликати" }));
    });
    expect(revokeInvite).toHaveBeenCalledWith(ORG, "i1");
  });
});
