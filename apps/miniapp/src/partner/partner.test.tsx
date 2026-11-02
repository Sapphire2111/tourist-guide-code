import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { ApiCallError, ConflictError } from "../host/types.js";
import { noopPartnerApi, PartnerProvider, resolveSelection } from "./context.js";
import { PartnerDashboard } from "./Dashboard.js";
import { AcceptInvite } from "./Invite.js";
import { offerInput } from "./Offers.js";
import {
  inviteTokenOf,
  type PartnerApi,
  type PartnerOrganization,
  type PartnerPlace,
} from "./partner-api.js";
import { patchOf, PlaceEditor, scheduleOf } from "./PlaceEditor.js";
import { PartnerStaff } from "./Staff.js";

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
  serviceRequests: true,
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
    expect(inviteTokenOf("inv_short")).toBeUndefined();
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
      startsAt: "2026-11-10T00:00:00.000Z",
      endsAt: null,
    });
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
    expect((await screen.findByTestId("place-status")).textContent).toBe("Потрібні доопрацювання");
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
    fireEvent.click(await screen.findByLabelText("Погоджуюсь з умовами для партнерів"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Надіслати на модерацію" }));
    });
    expect(screen.getByTestId("missing-fields").textContent).toBe(
      "Для модерації заповніть: Фото, Графік роботи",
    );
    expect(screen.getByTestId("submit-message").textContent).toContain("Заповніть обов’язкові поля");
  });

  it("на модерации — только чтение", async () => {
    setup(<PlaceEditor id={PLACE} />, {
      place: () => Promise.resolve(place({ status: "pending_moderation", editable: false })),
    });
    expect(await screen.findByTestId("editor-readonly")).toBeDefined();
    expect(screen.getByText("Заклад на перевірці в модератора.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Надіслати на модерацію" })).toBeNull();
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
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Запрошення втратило чинність. Попросіть нове.",
    );
    expect(screen.queryByRole("button", { name: "Прийняти" })).toBeNull();
  });
});
