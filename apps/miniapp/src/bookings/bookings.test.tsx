// Блок 7, интерфейс бронирования: «Доступно зараз» в карточке, C07/C08 (согласие обязательно, ключ идемпотентности,
// занятый слот, телефон из Telegram), «Мої бронювання» (статусы, причины, отмена, альтернатива), P04/P05 и ресурсы.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createTranslator } from "@tg/i18n";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import { PlaceCard } from "../guide/PlaceCard.js";
import type { GuideApi, PlaceDetail } from "../guide/types.js";
import { ApiCallError, ConflictError, NetworkError } from "../host/types.js";
import { noopPartnerApi, PartnerProvider } from "../partner/context.js";
import type { PartnerApi, PartnerRole } from "../partner/partner-api.js";
import { currentEntryKey, writeSlot } from "../back.js";
import { consumeBack, type TelegramWebApp } from "../telegram.js";
import type { BookingsApi, PartnerBooking, PartnerResource, Resource, SlotList } from "./bookings-api.js";
import { BookingsProvider } from "./context.js";
import {
  addDays,
  localDate,
  localTime,
  normalizePhone,
  reasonText,
  REASON_CODES,
  today,
  zonedIso,
} from "./format.js";
import { PartnerBookings, PartnerResources, rulesBody, weeklyOf } from "./PartnerScreens.js";
import { lazyScreen } from "./lazy.js";
import { BookingFlow, MyBookings, sortBookings } from "./TouristScreens.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TZ = "Europe/Kyiv";
const REGION = "00000000-0000-4000-8000-0000000000a1";
const PLACE = "00000000-0000-4000-8000-000000000201";
const RES = "00000000-0000-4000-8000-000000000301";
const B1 = "00000000-0000-4000-8000-000000000401";
const tomorrow = addDays(today(TZ), 1);
const at = (time: string, day = tomorrow) => zonedIso(day, time, TZ);

const place: PlaceDetail = {
  id: PLACE,
  name: { uk: "Садиба «Смерека»" },
  categoryId: "c1",
  location: null,
  distanceMeters: null,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
  description: null,
  address: null,
  phone: "+380501112233",
  website: null,
  telegram: null,
  photos: [],
  schedule: [],
  tags: [],
  verifiedAt: null,
  openUntil: null,
  favorite: null,
};

const resource = (over: Partial<Resource> = {}): Resource => ({
  id: RES,
  regionId: REGION,
  placeId: PLACE,
  name: { uk: "Чан №1" },
  description: null,
  capacityPeople: 4,
  slotDurationMin: 60,
  bookingMode: "request_confirm",
  priceMinor: null,
  currency: null,
  availability: { availableNow: false, source: null, manualExpiresAt: null },
  ...over,
});

const slots = (free = [true, true]): SlotList => ({
  resourceId: RES,
  timezone: TZ,
  from: today(TZ),
  days: 2,
  items: [
    { startsAt: at("10:00"), endsAt: at("11:00"), free: free[0]! },
    { startsAt: at("11:00"), endsAt: at("12:00"), free: free[1]! },
  ],
  availability: { availableNow: false, source: null, manualExpiresAt: null },
});

const booking = (over: Partial<PartnerBooking> = {}): PartnerBooking => ({
  id: B1,
  regionId: REGION,
  placeId: PLACE,
  placeName: { uk: "Садиба «Смерека»" },
  resourceId: RES,
  resourceName: { uk: "Чан №1" },
  status: "pending_partner",
  statusReason: null,
  statusReasonCode: null,
  timezone: TZ,
  startsAt: at("10:00"),
  endsAt: at("11:00"),
  peopleCount: 2,
  comment: null,
  alternative: null,
  partnerResponseDueAt: null,
  cancelDeadline: null,
  cancelTooLate: false,
  cancelBeforeStartHours: 2,
  allowedTransitions: ["cancelled_by_user"],
  history: [],
  createdAt: "2026-11-03T08:00:00Z",
  updatedAt: "2026-11-03T08:00:00Z",
  organizationId: "org1",
  source: "platform",
  customerName: "Олена",
  contactPhone: "+380501234567",
  ...over,
});

function fakeApi(over: Partial<BookingsApi> = {}): BookingsApi {
  const fail = () => Promise.reject(new Error("not mocked"));
  return {
    resources: vi.fn(async () => [resource()]),
    slots: vi.fn(async () => slots()),
    create: vi.fn(fail),
    mine: vi.fn(async () => []),
    setStatus: vi.fn(fail),
    partnerBookings: vi.fn(async () => []),
    createManual: vi.fn(fail),
    partnerResources: vi.fn(async () => []),
    partnerSlots: vi.fn(async () => slots()),
    createResource: vi.fn(fail),
    updateResource: vi.fn(fail),
    putAvailability: vi.fn(fail),
    putManual: vi.fn(fail),
    ...over,
  };
}

function renderWith(
  ui: ReactNode,
  {
    api = fakeApi(),
    flag = true,
    signedIn = true,
    webApp,
    partner,
    entryContextId,
  }: {
    api?: BookingsApi;
    flag?: boolean;
    signedIn?: boolean;
    webApp?: TelegramWebApp;
    partner?: { role: PartnerRole };
    entryContextId?: string;
  } = {},
) {
  const guide: GuideEnv = {
    api: { place: vi.fn(async () => place) } as unknown as GuideApi,
    analytics: noopAnalytics,
    webApp,
    base: null,
    regionId: REGION,
    signedIn,
  };
  const partnerApi: PartnerApi = partner
    ? ({
        ...noopPartnerApi(),
        me: async () => ({
          organizations: [
            {
              id: "org1",
              regionId: REGION,
              name: "ТОВ",
              role: partner.role,
              assignmentId: "a1",
              // Права — как abilitiesOf сервера: кассир — без ресурсов, правил и телефона клиента.
              abilities: {
                editPlace: partner.role !== "ORG_STAFF",
                editIdentity: partner.role === "ORG_OWNER",
                submit: partner.role === "ORG_OWNER",
                manageStaff: partner.role === "ORG_OWNER",
                manageOffers: partner.role !== "ORG_STAFF",
                serviceRequests: true,
                bookings: true,
                manualBooking: true,
                manageResources: partner.role !== "ORG_STAFF",
                editAvailability: partner.role !== "ORG_STAFF",
                manualAvailability: true,
                customerPhone: partner.role !== "ORG_STAFF",
              },
              places: [
                {
                  id: PLACE,
                  name: { uk: "Садиба" },
                  status: "published",
                  templateCode: null,
                  modules: [],
                  moderation: null,
                  openServiceRequests: null,
                  activeOffers: 0,
                },
              ],
            },
          ],
        }),
      } as PartnerApi)
    : noopPartnerApi();
  render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={{ "module.bookings": flag }}>
        <GuideProvider value={guide}>
          <PartnerProvider api={partnerApi} regionId={REGION} enabled={Boolean(partner)}>
            <BookingsProvider value={{ api, timeZone: TZ, entryContextId }}>{ui}</BookingsProvider>
          </PartnerProvider>
        </GuideProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
  return api;
}

const t = createTranslator("uk").t;

describe("format", () => {
  it("местное время региона ↔ UTC", () => {
    expect(zonedIso("2026-07-01", "10:00", TZ)).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedIso("2026-12-01", "10:00", TZ)).toBe("2026-12-01T08:00:00.000Z");
    expect(localTime("2026-12-01T08:00:00.000Z", TZ)).toBe("10:00");
  });

  it("телефон → E.164", () => {
    expect(normalizePhone("050 123 45 67")).toBe("+380501234567");
    expect(normalizePhone("380501234567")).toBe("+380501234567");
    expect(normalizePhone("+48 601 234 567")).toBe("+48601234567");
    expect(normalizePhone("12")).toBeNull();
    // Без «+» — только украинские варианты, страна не угадывается.
    expect(normalizePhone("50 123 45 67")).toBe("+380501234567");
    expect(normalizePhone("8 050 123 45 67")).toBe("+380501234567");
    expect(normalizePhone("(067) 111-22-33")).toBe("+380671112233");
    expect(normalizePhone("48601234567")).toBeNull();
    expect(normalizePhone("00501234567")).toBeNull();
    expect(normalizePhone("+38050123456")).toBeNull();
  });

  it("служебные коды причин (statusReasonCode, reasonCode) — переводом; текст туриста/партнёра — как есть", () => {
    expect(reasonText(null, "alternative_declined", t)).toBe("відмова від запропонованого часу");
    expect(reasonText(null, "customer_timeout", t)).toBe("не було відповіді на запропонований час");
    expect(reasonText(null, "partner_sla", t)).toBe("заклад не відповів вчасно");
    expect(reasonText(null, "auto_complete", t)).toBe("завершено автоматично");
    expect(reasonText("Не підходить час", "alternative_declined", t)).toBe(
      "відмова від запропонованого часу — Не підходить час",
    );
    expect(reasonText("Немає вільних столів", null, t)).toBe("Немає вільних столів");
    expect(reasonText("  ", null, t)).toBeNull();
    // Записи до разделения полей: код в тексте — тоже переводом.
    expect(reasonText("customer_timeout", null, t)).toBe("не було відповіді на запропонований час");
  });

  it("коды причин — ровно enum сервера BookingReasonCode, у каждого есть перевод", () => {
    expect(Object.keys(REASON_CODES).sort()).toEqual(
      [
        "alternative_declined",
        "auto_complete",
        "auto_confirm",
        "customer_timeout",
        "delivered_to_partner",
        "partner_sla",
      ].sort(),
    );
    for (const key of Object.values(REASON_CODES)) expect(t(key)).not.toBe(key);
  });
});

describe("C06: «Доступно зараз» и «Забронювати» в карточке", () => {
  it("свободный слот сейчас — «Доступно зараз» и кнопка брони", async () => {
    renderWith(<PlaceCard id={PLACE} />, {
      api: fakeApi({
        resources: vi.fn(async () => [
          resource({ availability: { availableNow: true, source: "slot", manualExpiresAt: null } }),
        ]),
      }),
    });
    expect(await screen.findByText("Доступно зараз")).toBeTruthy();
    expect(screen.getByTestId("badge-availability").textContent).toBe("Доступно зараз");
    expect(screen.getByTestId("place-book").getAttribute("href")).toBe(`#/book/${PLACE}`);
  });

  it("нет свободного слота и ручного статуса — бейджа доступности нет, бронь — по кнопке", async () => {
    renderWith(<PlaceCard id={PLACE} />);
    expect(await screen.findByTestId("place-book")).toBeTruthy();
    expect(screen.queryByTestId("badge-availability")).toBeNull();
  });

  it("флаг выключен — ресурсы не запрашиваются, как раньше", async () => {
    const api = renderWith(<PlaceCard id={PLACE} />, { flag: false });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByTestId("badge-availability")).toBeNull();
    expect(api.resources).not.toHaveBeenCalled();
    expect(screen.queryByTestId("place-book")).toBeNull();
  });

  it("без ресурсов — кнопки брони нет", async () => {
    const api = renderWith(<PlaceCard id={PLACE} />, { api: fakeApi({ resources: vi.fn(async () => []) }) });
    await screen.findByRole("heading", { level: 1 });
    await act(async () => undefined);
    expect(api.resources).toHaveBeenCalledWith(REGION, PLACE);
    expect(screen.queryByTestId("place-book")).toBeNull();
  });
});

async function toForm() {
  fireEvent.click(await screen.findByRole("button", { name: "10:00" }));
  fireEvent.click(screen.getByTestId("slot-pick"));
  await screen.findByTestId("booking-summary");
}

describe("C07/C08: «Назад» и повторная бронь", () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "050 123 45 67" },
    });
    fireEvent.click(screen.getByTestId("phone-consent"));
  };

  it("после заявки слот не остаётся в хранилище: перезагрузка не вернёт форму на тот же слот", async () => {
    renderWith(<BookingFlow placeId={PLACE} />, {
      api: fakeApi({ create: vi.fn(async () => booking({ status: "pending_partner" })) }),
    });
    await toForm();
    fill();
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem("tg.nav.v1")).toContain("startsAt");
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    await screen.findByTestId("booking-done");
    window.dispatchEvent(new Event("pagehide"));
    const stored = JSON.parse(sessionStorage.getItem("tg.nav.v1")!) as { slots: Record<string, unknown> }[];
    expect(stored.at(-1)!.slots["booking.slot"]).toBeNull();
  });

  it("подтверждение → «Мої бронювання» заменой: снимка статуса в истории нет", async () => {
    renderWith(<BookingFlow placeId={PLACE} />, {
      api: fakeApi({ create: vi.fn(async () => booking({ status: "pending_partner" })) }),
    });
    await toForm();
    fill();
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    const link = within(document.body).getByRole("link", { name: "Мої бронювання" });
    const length = window.history.length;
    await act(async () => fireEvent.click(link));
    expect(window.location.hash).toBe("#/bookings");
    expect(window.history.length).toBe(length);
  });

  it("пока заявка отправляется, «Назад» и «Змінити час» не снимают форму; неясный исход не теряется", async () => {
    let fail: (e: unknown) => void = () => undefined;
    const create = vi.fn(() => new Promise<never>((_, reject) => (fail = reject)));
    renderWith(<BookingFlow placeId={PLACE} />, { api: fakeApi({ create }) });
    await toForm();
    fill();
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(create).toHaveBeenCalledTimes(1);
    const change = screen.getByRole("button", { name: "Змінити час" }) as HTMLButtonElement;
    expect(change.disabled).toBe(true);
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.getByTestId("booking-summary")).toBeTruthy();

    await act(async () => fail(new NetworkError()));
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    // Форма снята, но исход неизвестен: подсказка проверить «Мої бронювання».
    expect(screen.queryByTestId("booking-summary")).toBeNull();
    expect(await screen.findByTestId("check-mine")).toBeTruthy();
  });

  it("ушли, пока заявка отправлялась: при возврате подсказка проверить брони; определённый отказ — без неё", async () => {
    window.history.replaceState(null, "", "#/book/x");
    const create = vi.fn(() => new Promise<never>(() => undefined));
    renderWith(<BookingFlow placeId={PLACE} />, { api: fakeApi({ create }) });
    await toForm();
    fill();
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(screen.queryByTestId("check-mine")).toBeNull();
    window.location.hash = "#/help";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    cleanup();
    const before = window.location.hash;
    window.history.back();
    await vi.waitFor(() => expect(window.location.hash).not.toBe(before));
    renderWith(<BookingFlow placeId={PLACE} />, { api: fakeApi({ create }) });
    expect(await screen.findByTestId("check-mine")).toBeTruthy();
    cleanup();
    sessionStorage.clear();
  });

  it("определённый отказ сервера — подсказки нет", async () => {
    const create = vi.fn(async () => {
      throw new ApiCallError(400, null);
    });
    renderWith(<BookingFlow placeId={PLACE} />, { api: fakeApi({ create }) });
    await toForm();
    fill();
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("check-mine")).toBeNull();
  });

  it("брони из сохранённого открытого пункта нет в списке — без фантомного шага «Назад»", async () => {
    writeSlot(currentEntryKey(), "pbooking.open", "gone");
    renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [partnerResource()]),
        partnerBookings: vi.fn(async () => []),
      }),
    });
    await screen.findByRole("heading", { level: 1 });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(consumeBack()).toBe(false);
  });
});

describe("C07/C08: бронирование", () => {
  it("занятый слот недоступен для выбора", async () => {
    renderWith(<BookingFlow placeId={PLACE} />, {
      api: fakeApi({ slots: vi.fn(async () => slots([false, true])) }),
    });
    const busy = await screen.findByRole("button", { name: "10:00 — зайнято" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it("без галочки согласия заявка не отправляется; с ней — телефон, согласие и ключ идемпотентности", async () => {
    const created = booking({ status: "pending_partner" });
    const api = renderWith(<BookingFlow placeId={PLACE} />, {
      api: fakeApi({ create: vi.fn(async () => created) }),
    });
    await toForm();
    const submit = screen.getByTestId("booking-submit") as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "050 123 45 67" },
    });
    expect(screen.getByTestId("phone-normalized").textContent).toBe("Номер: +380501234567");
    expect(screen.getByTestId("summary-phone").textContent).toBe("+380501234567");
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("Без згоди на передачу номера заявку не надіслати.")).toBeTruthy();
    fireEvent.submit(submit.closest("form")!);
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByText("Позначте згоду на передачу номера закладу.")).toBeTruthy();

    fireEvent.click(screen.getByTestId("phone-consent"));
    expect(screen.getByLabelText(/закладу «Садиба «Смерека»» для підтвердження бронювання/)).toBeTruthy();
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Більше осіб" }));
    await act(async () => fireEvent.click(submit));
    expect(api.create).toHaveBeenCalledWith(
      {
        regionId: REGION,
        resourceId: RES,
        startsAt: at("10:00"),
        peopleCount: 2,
        phone: "+380501234567",
        phoneSource: "manual",
        phoneShareConsent: true,
      },
      expect.stringMatching(/.+/),
    );
    expect(await screen.findByTestId("booking-done")).toBeTruthy();
    expect(screen.getByTestId("booking-status").textContent).toBe("Очікує підтвердження");
  });

  it("сбой сети — повтор с тем же ключом; слот заняли — назад к слотам с объяснением", async () => {
    const create = vi
      .fn<BookingsApi["create"]>()
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(new ConflictError("errors.booking.slotTaken"));
    const api = renderWith(<BookingFlow placeId={PLACE} />, { api: fakeApi({ create }) });
    await toForm();
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "+380501234567" },
    });
    fireEvent.click(screen.getByTestId("phone-consent"));
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(screen.getByTestId("booking-message").textContent).toContain("Немає відповіді від сервера");
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(create.mock.calls[1]![1]).toBe(create.mock.calls[0]![1]);
    expect(await screen.findByText("Цей час щойно зайняли — оберіть інший.")).toBeTruthy();
    expect(screen.queryByTestId("booking-summary")).toBeNull();
    expect(api.slots).toHaveBeenCalledTimes(2);
    // Прежняя попытка с неясным исходом — подсказка проверить «Мої бронювання».
    expect(screen.getByTestId("check-mine").textContent).toContain("Мої бронювання");
  });

  it("телефон из Telegram (requestContact) — источник telegram_contact", async () => {
    const webApp = {
      ready() {},
      expand() {},
      initDataUnsafe: { user: { id: 1, first_name: "Олена" } },
      requestContact: (cb: (sent: boolean, res?: unknown) => void) =>
        cb(true, { responseUnsafe: { contact: { phone_number: "380501234567" } } }),
    } as unknown as TelegramWebApp;
    const api = renderWith(<BookingFlow placeId={PLACE} />, {
      webApp,
      api: fakeApi({ create: vi.fn(async () => booking()) }),
    });
    await toForm();
    expect(screen.getByTestId("booking-summary").textContent).toContain("Олена");
    fireEvent.click(screen.getByTestId("share-contact"));
    expect((screen.getByLabelText("Телефон для підтвердження") as HTMLInputElement).value).toBe(
      "+380501234567",
    );
    fireEvent.click(screen.getByTestId("phone-consent"));
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+380501234567", phoneSource: "telegram_contact" }),
      expect.any(String),
    );
  });

  it("имя из Telegram — только подсказка, в заявку не уходит; контекст входа (QR) — уходит", async () => {
    const webApp = {
      ready() {},
      expand() {},
      initDataUnsafe: { user: { id: 1, first_name: "Олена", last_name: "Коваль" } },
    } as unknown as TelegramWebApp;
    const api = renderWith(<BookingFlow placeId={PLACE} />, {
      webApp,
      entryContextId: "00000000-0000-4000-8000-0000000000e1",
      api: fakeApi({ create: vi.fn(async () => booking()) }),
    });
    await toForm();
    const name = screen.getByLabelText("Імʼя для закладу") as HTMLInputElement;
    expect(name.value).toBe("");
    expect(name.placeholder).toBe("Олена Коваль");
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "+380501234567" },
    });
    fireEvent.click(screen.getByTestId("phone-consent"));
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    const body = vi.mocked(api.create).mock.calls[0]![0];
    expect(body).not.toHaveProperty("customerName");
    expect(body.entryContextId).toBe("00000000-0000-4000-8000-0000000000e1");
  });

  it("имя, введённое туристом, уходит в заявку", async () => {
    const webApp = {
      ready() {},
      expand() {},
      initDataUnsafe: { user: { id: 1, first_name: "Олена", last_name: "Коваль" } },
    } as unknown as TelegramWebApp;
    const api = renderWith(<BookingFlow placeId={PLACE} />, {
      webApp,
      entryContextId: "00000000-0000-4000-8000-0000000000e1",
      api: fakeApi({ create: vi.fn(async () => booking()) }),
    });
    await toForm();
    const name = screen.getByLabelText("Імʼя для закладу") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "  Олена К. " } });
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "+380501234567" },
    });
    fireEvent.click(screen.getByTestId("phone-consent"));
    await act(async () => fireEvent.click(screen.getByTestId("booking-submit")));
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: "Олена К.",
        entryContextId: "00000000-0000-4000-8000-0000000000e1",
      }),
      expect.any(String),
    );
  });

  it("без входа отправить нельзя", async () => {
    renderWith(<BookingFlow placeId={PLACE} />, { signedIn: false });
    await toForm();
    expect(screen.getByTestId("booking-needs-login")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Телефон для підтвердження"), {
      target: { value: "+380501234567" },
    });
    fireEvent.click(screen.getByTestId("phone-consent"));
    expect((screen.getByTestId("booking-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("C21: Мої бронювання", () => {
  it("статусы по-украински, причины без служебных кодов, активные — сверху", async () => {
    renderWith(<MyBookings />, {
      api: fakeApi({
        mine: vi.fn(async () => [
          booking({
            id: "b-old",
            status: "cancelled_by_user",
            statusReasonCode: "alternative_declined",
            allowedTransitions: [],
          }),
          booking({
            id: "b-exp",
            status: "expired",
            statusReason: null,
            statusReasonCode: "partner_sla",
            allowedTransitions: [],
          }),
          booking({ id: "b-new", status: "pending_partner" }),
        ]),
      }),
    });
    const items = await screen.findAllByTestId("my-booking");
    expect(items.map((i) => within(i).getByTestId("booking-status").textContent)).toEqual([
      "Очікує підтвердження",
      "Скасовано вами",
      "Термін відповіді минув",
    ]);
    expect(within(items[1]!).getByTestId("booking-reason").textContent).toBe(
      "Причина: відмова від запропонованого часу",
    );
    expect(within(items[2]!).getByTestId("booking-reason").textContent).toBe(
      "Причина: заклад не відповів вчасно",
    );
    expect(document.body.textContent).not.toContain("alternative_declined");
    expect(document.body.textContent).not.toContain("partner_sla");
  });

  it("отмена: подтверждение, cancel_too_late — понятный текст с часами", async () => {
    const setStatus = vi
      .fn<BookingsApi["setStatus"]>()
      .mockRejectedValue(
        new ApiCallError(422, "errors.booking.cancelTooLate", "UNPROCESSABLE", { beforeStartHours: 2 }),
      );
    renderWith(<MyBookings />, {
      api: fakeApi({ mine: vi.fn(async () => [booking({ status: "confirmed" })]), setStatus }),
    });
    expect((await screen.findByTestId("cancel-rule")).textContent).toBe(
      "Скасувати онлайн можна не пізніше ніж за 2 год до початку.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Скасувати бронювання" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Так, скасувати" })));
    expect(setStatus).toHaveBeenCalledWith(B1, REGION, { status: "cancelled_by_user" });
    expect(screen.getByTestId("my-booking-message").textContent).toContain(
      "Скасувати онлайн можна не пізніше ніж за 2 год до початку — зателефонуйте закладу.",
    );
  });

  it("подтверждённая бронь после срока отмены (сервер: cancelTooLate) — кнопки нет, подсказка позвонить", async () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const deadline = new Date(Date.parse(soon) - 2 * 3_600_000).toISOString();
    renderWith(<MyBookings />, {
      api: fakeApi({
        mine: vi.fn(async () => [
          booking({ status: "confirmed", startsAt: soon, cancelDeadline: deadline, cancelTooLate: true }),
        ]),
      }),
    });
    expect((await screen.findByTestId("cancel-rule")).textContent).toContain("зателефонуйте закладу");
    expect(screen.queryByRole("button", { name: "Скасувати бронювання" })).toBeNull();
  });

  it("срок отмены прошёл, пока экран открыт (cancelDeadline в прошлом), — кнопки нет; часы правила — с сервера", async () => {
    renderWith(<MyBookings />, {
      api: fakeApi({
        mine: vi.fn(async () => [
          booking({
            status: "confirmed",
            cancelDeadline: new Date(Date.now() - 1000).toISOString(),
            cancelBeforeStartHours: 3,
          }),
        ]),
      }),
    });
    expect((await screen.findByTestId("cancel-rule")).textContent).toContain("за 3 год");
    expect(screen.queryByRole("button", { name: "Скасувати бронювання" })).toBeNull();
  });

  it("альтернатива: прийняти → confirmed", async () => {
    const alt = booking({
      status: "alternative_proposed",
      allowedTransitions: ["confirmed", "cancelled_by_user"],
      alternative: { startsAt: at("12:00"), endsAt: at("13:00"), respondBy: at("09:00") },
    });
    const setStatus = vi.fn(async () => ({ ...alt, status: "confirmed" as const, alternative: null }));
    renderWith(<MyBookings />, { api: fakeApi({ mine: vi.fn(async () => [alt]), setStatus }) });
    expect((await screen.findByTestId("booking-alternative")).textContent).toContain("12:00");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Прийняти" })));
    expect(setStatus).toHaveBeenCalledWith(B1, REGION, { status: "confirmed" });
    expect(screen.getByTestId("booking-status").textContent).toBe("Підтверджено");
  });

  it("sortBookings: активные по времени, прошлые — новые сверху", () => {
    const list = sortBookings([
      booking({ id: "a", status: "completed", startsAt: "2026-11-01T10:00:00Z" }),
      booking({ id: "b", status: "confirmed", startsAt: "2026-11-09T10:00:00Z" }),
      booking({ id: "c", status: "pending_partner", startsAt: "2026-11-05T10:00:00Z" }),
      booking({ id: "d", status: "no_show", startsAt: "2026-11-02T10:00:00Z" }),
    ]);
    expect(list.map((b) => b.id)).toEqual(["c", "b", "d", "a"]);
  });
});

const partnerResource = (over: Partial<PartnerResource> = {}): PartnerResource => ({
  ...resource(),
  organizationId: "org1",
  status: "active",
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  leadTimeMin: 60,
  horizonDays: 30,
  confirmSlaMin: 30,
  manualAvailability: "unknown",
  rules: [
    { dayOfWeek: 1, date: null, closed: false, opensAt: "10:00", closesAt: "18:00" },
    { dayOfWeek: null, date: "2026-12-31", closed: true, opensAt: null, closesAt: null },
  ],
  version: 3,
  updatedAt: "2026-11-03T08:00:00Z",
  ...over,
});

describe("P04/P05: бронирования партнёра", () => {
  it("P04: брони дня по ресурсу; P05: действия по allowedTransitions, отказ — только с причиной", async () => {
    const setStatus = vi.fn(async () => booking({ status: "cancelled_by_partner" }));
    const api = renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [partnerResource()]),
        partnerBookings: vi.fn(async () => [
          booking({
            startsAt: at("10:00", today(TZ)),
            endsAt: at("11:00", today(TZ)),
            allowedTransitions: ["confirmed", "alternative_proposed", "cancelled_by_partner"],
          }),
        ]),
        setStatus,
      }),
    });
    const row = await screen.findByTestId("pbooking-row");
    expect(row.textContent).toContain("10:00–11:00 · Олена · осіб: 2");
    expect(api.partnerBookings).toHaveBeenCalledWith(
      PLACE,
      zonedIso(today(TZ), "00:00", TZ),
      zonedIso(addDays(today(TZ), 1), "00:00", TZ),
    );
    fireEvent.click(row);
    const actions = await screen.findByTestId("pbooking-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Підтвердити", "Запропонувати інший час", "Відхилити"]);
    expect(screen.getByTestId("pbooking-phone").textContent).toBe("+380501234567");
    fireEvent.click(within(actions).getByRole("button", { name: "Відхилити" }));
    fireEvent.submit(screen.getByLabelText("Причина відмови (її побачить клієнт)").closest("form")!);
    expect(setStatus).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Причина відмови (її побачить клієнт)"), {
      target: { value: "Чан на ремонті" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Відхилити бронювання" })));
    expect(setStatus).toHaveBeenCalledWith(B1, REGION, {
      status: "cancelled_by_partner",
      reason: "Чан на ремонті",
    });
  });

  it("P05: альтернатива — слоты партнёра (место может быть не опубликовано); история — коды переводом", async () => {
    const api = renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [partnerResource()]),
        partnerBookings: vi.fn(async () => [
          booking({
            startsAt: at("10:00", today(TZ)),
            allowedTransitions: ["confirmed", "alternative_proposed", "cancelled_by_partner"],
            history: [
              {
                fromStatus: "new",
                toStatus: "pending_partner",
                actor: "system",
                reason: null,
                reasonCode: "delivered_to_partner",
                at: "2026-11-03T08:00:00Z",
              },
            ],
          }),
        ]),
      }),
    });
    fireEvent.click(await screen.findByTestId("pbooking-row"));
    expect(document.body.textContent).toContain("заявку передано закладу");
    expect(document.body.textContent).not.toContain("delivered_to_partner");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Запропонувати інший час" })));
    expect(api.partnerSlots).toHaveBeenCalledWith(RES, localDate(at("10:00", today(TZ)), TZ), 1);
    expect(api.slots).not.toHaveBeenCalled();
  });

  it("кассир: телефона нет — пояснение; статус уже сменился — предложить обновить", async () => {
    const setStatus = vi
      .fn<BookingsApi["setStatus"]>()
      .mockRejectedValue(new ConflictError("errors.booking.invalidTransition"));
    renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_STAFF" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [partnerResource()]),
        partnerBookings: vi.fn(async () => [
          booking({
            startsAt: at("10:00", today(TZ)),
            contactPhone: null,
            allowedTransitions: ["confirmed"],
          }),
        ]),
        setStatus,
      }),
    });
    fireEvent.click(await screen.findByTestId("pbooking-row"));
    expect(screen.getByTestId("pbooking-phone").textContent).toBe(
      "Телефон бачать менеджер і власник закладу.",
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Підтвердити" })));
    expect(screen.getByTestId("pbooking-message").textContent).toContain("Статус бронювання вже змінився");
    expect(screen.getByRole("button", { name: "Оновити дані" })).toBeTruthy();
  });

  it("ручная запись: имя обязательно, время — местное, источник «власний»", async () => {
    const createManual = vi.fn(async () => booking({ source: "manual", status: "confirmed" }));
    renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_STAFF" },
      api: fakeApi({ partnerResources: vi.fn(async () => [partnerResource()]), createManual }),
    });
    fireEvent.click(await screen.findByTestId("manual-add"));
    const form = screen.getByTestId("manual-form");
    fireEvent.change(within(form).getByLabelText("Час"), { target: { value: "15:30" } });
    fireEvent.submit(form);
    expect(createManual).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Імʼя клієнта"), { target: { value: "Іван" } });
    await act(async () => fireEvent.submit(form));
    expect(createManual).toHaveBeenCalledWith(
      {
        resourceId: RES,
        startsAt: zonedIso(today(TZ), "15:30", TZ),
        peopleCount: 1,
        customerName: "Іван",
        source: "manual",
      },
      expect.any(String),
    );
    expect(screen.getByTestId("pbooking-notice").textContent).toContain("Запис додано");
  });
});

describe("Ресурсы партнёра", () => {
  it("правила: недельные окна + даты без изменений; закрытие раньше открытия — ошибка", () => {
    const r = partnerResource();
    const weekly = weeklyOf(r.rules);
    expect(weekly[1]).toEqual([{ opensAt: "10:00", closesAt: "18:00" }]);
    expect(rulesBody({ ...weekly, 2: [{ opensAt: "09:00", closesAt: "12:00" }] }, r.rules)).toEqual([
      { dayOfWeek: 1, opensAt: "10:00", closesAt: "18:00" },
      { dayOfWeek: 2, opensAt: "09:00", closesAt: "12:00" },
      { date: "2026-12-31", closed: true, opensAt: null, closesAt: null },
    ]);
    expect(rulesBody({ ...weekly, 3: [{ opensAt: "12:00", closesAt: "09:00" }] }, r.rules)).toBeNull();
  });

  it("правка с version; 409 versionConflict — сообщение и «Оновити дані»", async () => {
    const updateResource = vi
      .fn<BookingsApi["updateResource"]>()
      .mockRejectedValue(
        new ConflictError("errors.resource.versionConflict", "CONFLICT", { currentVersion: 4 }),
      );
    const partnerResources = vi.fn(async () => [partnerResource()]);
    renderWith(<PartnerResources placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({ partnerResources, updateResource }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Налаштування" }));
    fireEvent.change(screen.getByLabelText("Осіб на слот"), { target: { value: "6" } });
    await act(async () => fireEvent.submit(screen.getByTestId("resource-form")));
    expect(updateResource).toHaveBeenCalledWith(
      RES,
      expect.objectContaining({ capacityPeople: 6, version: 3 }),
    );
    expect(screen.getByTestId("resource-message").textContent).toContain("Ресурс щойно змінили");
    await act(async () => fireEvent.click(screen.getByTestId("resource-refresh")));
    expect(partnerResources).toHaveBeenCalledTimes(2);
  });

  it("кассир: только ручной статус «Доступно зараз» с TTL, без настроек", async () => {
    const putManual = vi.fn(async () =>
      partnerResource({
        manualAvailability: "available_now",
        availability: { availableNow: true, source: "manual", manualExpiresAt: at("12:00") },
      }),
    );
    renderWith(<PartnerResources placeId={PLACE} />, {
      partner: { role: "ORG_STAFF" },
      api: fakeApi({ partnerResources: vi.fn(async () => [partnerResource()]), putManual }),
    });
    await screen.findByTestId("manual-status");
    expect(screen.queryByRole("button", { name: "Налаштування" })).toBeNull();
    expect(screen.queryByTestId("resource-new")).toBeNull();
    fireEvent.change(screen.getByLabelText("Діє"), { target: { value: "30" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Є вільні місця" })));
    expect(putManual).toHaveBeenCalledWith(RES, "available_now", 30);
  });

  it("менеджер: правила и настройки по abilities; снять ручной статус — без TTL", async () => {
    const putManual = vi.fn(async () => partnerResource());
    renderWith(<PartnerResources placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [
          partnerResource({
            manualAvailability: "busy",
            availability: { availableNow: false, source: null, manualExpiresAt: at("12:00") },
          }),
        ]),
        putManual,
      }),
    });
    await screen.findByTestId("manual-status");
    expect(screen.getByRole("button", { name: "Налаштування" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Доступність по днях" })).toBeTruthy();
    const clear = within(screen.getByTestId("manual-status")).getByRole("button", {
      name: t("miniapp.pres.clear"),
    });
    await act(async () => fireEvent.click(clear));
    expect(putManual).toHaveBeenCalledWith(RES, "unknown", undefined);
  });
});

describe("доработки после проверки", () => {
  it("403 — «Немає прав для цієї дії»; responseOverdue — «Оновити дані»", async () => {
    const setStatus = vi
      .fn<BookingsApi["setStatus"]>()
      .mockRejectedValueOnce(new ApiCallError(403, "errors.forbidden", "FORBIDDEN"))
      .mockRejectedValueOnce(new ConflictError("errors.booking.responseOverdue"));
    renderWith(<PartnerBookings placeId={PLACE} />, {
      partner: { role: "ORG_STAFF" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [partnerResource()]),
        partnerBookings: vi.fn(async () => [
          booking({ startsAt: at("10:00", today(TZ)), allowedTransitions: ["confirmed"] }),
        ]),
        setStatus,
      }),
    });
    fireEvent.click(await screen.findByTestId("pbooking-row"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Підтвердити" })));
    expect(screen.getByTestId("pbooking-message").textContent).toContain("Немає прав для цієї дії.");
    expect(screen.queryByRole("button", { name: "Оновити дані" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Підтвердити" })));
    expect(screen.getByRole("button", { name: "Оновити дані" })).toBeTruthy();
  });

  it("правка ресурса не затирает en в названии и описании", async () => {
    const updateResource = vi.fn(async () => partnerResource());
    renderWith(<PartnerResources placeId={PLACE} />, {
      partner: { role: "ORG_OWNER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [
          partnerResource({
            name: { uk: "Чан №1", en: "Hot tub 1" },
            description: { uk: "Біля річки", en: "By the river" },
          }),
        ]),
        updateResource,
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Налаштування" }));
    fireEvent.change(screen.getByLabelText("Назва (наприклад, «Чан №1»)"), { target: { value: "Чан №2" } });
    await act(async () => fireEvent.submit(screen.getByTestId("resource-form")));
    expect(updateResource).toHaveBeenCalledWith(
      RES,
      expect.objectContaining({
        name: { uk: "Чан №2", en: "Hot tub 1" },
        description: { uk: "Біля річки", en: "By the river" },
      }),
    );
  });

  it("окно до 24:00 остаётся 24:00 (не 23:59)", async () => {
    const putAvailability = vi.fn(async () => partnerResource());
    renderWith(<PartnerResources placeId={PLACE} />, {
      partner: { role: "ORG_MANAGER" },
      api: fakeApi({
        partnerResources: vi.fn(async () => [
          partnerResource({
            rules: [{ dayOfWeek: 5, date: null, closed: false, opensAt: "18:00", closesAt: "24:00" }],
          }),
        ]),
        putAvailability,
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Доступність по днях" }));
    const friday = screen.getAllByTestId("rules-day")[4]!;
    expect((within(friday).getByLabelText("до 24:00") as HTMLInputElement).checked).toBe(true);
    await act(async () => fireEvent.submit(screen.getByTestId("rules-form")));
    expect(putAvailability).toHaveBeenCalledWith(RES, [
      { dayOfWeek: 5, opensAt: "18:00", closesAt: "24:00" },
    ]);
  });

  it("ленивый экран: сбой загрузки чанка — сообщение и повтор", async () => {
    let fail = true;
    const Screen = lazyScreen(async () => {
      if (fail) throw new Error("chunk");
      return () => <p>Екран</p>;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <I18nProvider locale="uk">
        <Screen />
      </I18nProvider>,
    );
    expect(await screen.findByTestId("screen-load-error")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
    expect(await screen.findByText("Екран")).toBeTruthy();
  });
});
