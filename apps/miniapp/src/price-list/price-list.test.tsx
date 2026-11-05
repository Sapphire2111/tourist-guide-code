// Прайс заведения (миграция 0030): ввод и показ цены; «Ціни» в карточке (свернуто до 6, «Показати все», нет
// позиций/ошибка — блока нет); экран кабинета «Прайс» (пустой прайс с примером и быстрым стартом, «+ Позиція» →
// лист правки, валидация цены, ▲▼, скрыть раздел, конфликт версии → перечитать, кассиру — «керують власник і
// менеджер»).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createTranslator, loadLocale } from "@tg/i18n";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import type { Analytics } from "../guide/analytics.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import { PlaceCard } from "../guide/PlaceCard.js";
import type { GuideApi, PlaceDetail, PriceListView } from "../guide/types.js";
import { ConflictError } from "../host/types.js";
import { noopPartnerApi, PartnerProvider } from "../partner/context.js";
import type { PartnerApi, PartnerOrganization, PriceItem, PriceList } from "../partner/partner-api.js";
import { PartnerPriceList } from "../partner/PriceList.js";
import { firstItems, PlacePrices } from "./PlacePrices.js";
import { parsePrice, priceInput, priceText } from "./price.js";

afterEach(cleanup);

const PLACE = "00000000-0000-4000-8000-00000000b001";
const S1 = "00000000-0000-4000-8000-0000000000c1";
const S2 = "00000000-0000-4000-8000-0000000000c2";
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const norm = (s: string | null) => (s ?? "").replace(/\s/g, " ");

describe("ціна", () => {
  it("parsePrice: гривні → копійки; кома й крапка; пробіли тисяч; не число / 3 знаки / мінус — null", () => {
    expect(parsePrice("180")).toBe(18000);
    expect(parsePrice("99,5")).toBe(9950);
    expect(parsePrice(" 99.50 ")).toBe(9950);
    expect(parsePrice("1 500")).toBe(150000);
    expect(parsePrice("0")).toBe(0);
    for (const bad of ["", "abc", "-5", "1,234", "1.2.3", "10000001"])
      expect(parsePrice(bad), bad).toBeNull();
  });

  it("priceInput і priceText: «від», одиниця, копійки лише коли є", async () => {
    expect(priceInput(18000)).toBe("180");
    expect(priceInput(9905)).toBe("99,05");
    const { t } = createTranslator("uk");
    expect(priceText(t, "uk", { priceMinor: 18000, priceFrom: false })).toBe("180 грн");
    expect(norm(priceText(t, "uk", { priceMinor: 150000, priceFrom: true }, "за 2 години"))).toBe(
      "від 1 500 грн за 2 години",
    );
    expect(priceText(t, "uk", { priceMinor: 9950, priceFrom: false })).toBe("99,50 грн");
    await loadLocale("en");
    const en = createTranslator("en");
    expect(priceText(en.t, "en", { priceMinor: 18000, priceFrom: true })).toBe("from UAH 180");
  });
});

// --- карточка ---

const item = (n: number) => ({
  id: `i${n}`,
  name: { uk: `Страва ${n}` },
  description: n === 1 ? { uk: "З бринзою" } : null,
  priceMinor: 10000 + n * 100,
  priceFrom: n === 2,
  unit: n === 1 ? { uk: "за порцію" } : null,
});

function renderCard(priceList?: GuideApi["priceList"]) {
  const env: GuideEnv = {
    api: { priceList } as unknown as GuideApi,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
    base: null,
    regionId: "r",
    signedIn: false,
  };
  render(
    <GuideProvider value={env}>
      <PlacePrices placeId={PLACE} />
    </GuideProvider>,
  );
  return flush();
}

describe("«Ціни» в картці", () => {
  it("firstItems: перші N позицій по розділах, порожні розділи відкидаються", () => {
    const sections: PriceListView["sections"] = [
      { id: "a", title: { uk: "A" }, items: [item(1), item(2)] },
      { id: "b", title: { uk: "B" }, items: [item(3), item(4)] },
    ];
    expect(firstItems(sections, 3).map((s) => s.items.length)).toEqual([2, 1]);
    expect(firstItems(sections, 2).map((s) => s.id)).toEqual(["a"]);
  });

  it("згорнуто до 6 позицій; «Показати все (8)» розгортає; заголовки розділів, коли їх кілька", async () => {
    const load = vi.fn(async () => ({
      sections: [
        { id: "a", title: { uk: "Страви" }, items: [1, 2, 3, 4, 5].map(item) },
        { id: "b", title: { uk: "Напої" }, items: [6, 7, 8].map(item) },
      ],
    }));
    await renderCard(load);
    expect(load).toHaveBeenCalledWith(PLACE);
    const block = screen.getByTestId("place-prices");
    expect(within(block).getByRole("heading", { level: 2, name: "Ціни" })).toBeTruthy();
    expect(within(block).getAllByTestId("place-price")).toHaveLength(6);
    expect(within(block).getByRole("heading", { level: 3, name: "Страви" })).toBeTruthy();
    const first = within(block).getAllByTestId("place-price")[0]!;
    expect(first.textContent).toContain("З бринзою");
    expect(norm(first.textContent)).toContain("101 грн за порцію");
    expect(norm(within(block).getAllByTestId("place-price")[1]!.textContent)).toContain("від 102 грн");
    const more = within(block).getByRole("button", { name: "Показати все (8)" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(within(block).getAllByTestId("place-price")).toHaveLength(8);
    expect(within(block).getByRole("button", { name: "Згорнути" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(within(block).getByText("Ціни вказує заклад — уточнюйте на місці.")).toBeTruthy();
  });

  it("один розділ — без заголовка розділу і без «Показати все»", async () => {
    await renderCard(async () => ({ sections: [{ id: "a", title: { uk: "Страви" }, items: [item(1)] }] }));
    const block = screen.getByTestId("place-prices");
    expect(within(block).queryByRole("heading", { level: 3 })).toBeNull();
    expect(within(block).queryByRole("button")).toBeNull();
  });

  it("немає позицій, помилка або api без прайсу — блоку немає", async () => {
    await renderCard(async () => ({ sections: [{ id: "a", title: { uk: "Порожній" }, items: [] }] }));
    expect(screen.queryByTestId("place-prices")).toBeNull();
    cleanup();
    await renderCard(() => Promise.reject(new Error("500")));
    expect(screen.queryByTestId("place-prices")).toBeNull();
    cleanup();
    await renderCard(undefined);
    expect(screen.queryByTestId("place-prices")).toBeNull();
  });
});

describe("картка: запит «Ціни» лише з hasPriceList", () => {
  const detail = (hasPriceList: boolean): PlaceDetail => ({
    id: PLACE,
    name: { uk: "Колиба" },
    categoryId: "c1",
    location: null,
    distanceMeters: null,
    cover: null,
    openNow: null,
    recommended: false,
    adLabel: null,
    description: null,
    address: null,
    phone: null,
    website: null,
    telegram: null,
    photos: [],
    schedule: [],
    tags: [],
    verifiedAt: null,
    openUntil: null,
    favorite: null,
    hasPriceList,
  });
  const mount = async (hasPriceList: boolean) => {
    const priceList = vi.fn(async () => ({
      sections: [{ id: "a", title: { uk: "Страви" }, items: [item(1)] }],
    }));
    const env: GuideEnv = {
      api: { place: vi.fn(async () => detail(hasPriceList)), priceList } as unknown as GuideApi,
      analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
      base: null,
      regionId: "r",
      signedIn: false,
    };
    render(
      <GuideProvider value={env}>
        <PlaceCard id={PLACE} />
      </GuideProvider>,
    );
    await flush();
    await flush();
    return priceList;
  };

  it("false — без другого запиту й без блоку; true — блок «Ціни»", async () => {
    expect(await mount(false)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("place-prices")).toBeNull();
    cleanup();
    expect(await mount(true)).toHaveBeenCalledWith(PLACE);
    expect(screen.getByTestId("place-prices")).toBeTruthy();
  });
});

// --- кабинет ---

const abilities = (manage: boolean) => ({
  editPlace: manage,
  editIdentity: false,
  submit: false,
  manageStaff: false,
  manageOffers: manage,
  managePriceList: manage,
  serviceRequests: true,
  bookings: true,
  manualBooking: true,
  manageResources: manage,
  editAvailability: manage,
  manualAvailability: true,
  customerPhone: manage,
});

const org = (role: PartnerOrganization["role"]): PartnerOrganization => ({
  id: "org",
  regionId: "r1",
  name: "ТОВ Ватра",
  role,
  assignmentId: "as1",
  abilities: abilities(role !== "ORG_STAFF"),
  places: [
    {
      id: PLACE,
      name: { uk: "Колиба Ватра" },
      status: "published",
      templateCode: "food",
      modules: ["offers"],
      moderation: null,
      openServiceRequests: null,
      activeOffers: 0,
    },
  ],
});

const priceItem = (over: Partial<PriceItem>): PriceItem => ({
  id: "it1",
  sectionId: S1,
  name: { uk: "Банош" },
  description: null,
  priceMinor: 18000,
  currency: "UAH",
  priceFrom: false,
  unit: null,
  hidden: false,
  sortOrder: 0,
  version: 1,
  updatedAt: "2026-11-05T10:00:00Z",
  ...over,
});

const listOf = (sections: PriceList["sections"]): PriceList => ({
  placeId: PLACE,
  sections,
  itemCount: sections.reduce((n, s) => n + s.items.length, 0),
  limits: { maxItems: 200, maxSections: 30 },
});

const food = (items: PriceItem[] = [], over = {}) => ({
  id: S1,
  title: { uk: "Страви" },
  hidden: false,
  sortOrder: 0,
  version: 1,
  items,
  ...over,
});

function setup(ui: ReactNode, api: Partial<PartnerApi>, role: PartnerOrganization["role"] = "ORG_MANAGER") {
  const full = {
    ...noopPartnerApi(),
    me: async () => ({ organizations: [org(role)] }),
    ...api,
  } as PartnerApi;
  const merged = new Proxy(full, {
    get: (target, key: string) =>
      (full as Record<string, unknown>)[key] ?? (() => Promise.reject(new Error("no api"))),
  });
  return render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={{ "module.partner_cabinet": true }}>
        <PartnerProvider api={merged} regionId="r1" enabled>
          {ui}
        </PartnerProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
}

describe("кабінет: «Прайс»", () => {
  it("порожній прайс: приклад і швидкий старт; «+ Страви» створює розділ", async () => {
    const createPriceSection = vi.fn(async () => listOf([food()]));
    setup(<PartnerPriceList placeId={PLACE} />, {
      priceList: async () => listOf([]),
      createPriceSection,
    });
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Прайс" })).toBeTruthy();
    const empty = screen.getByTestId("prices-empty");
    expect(empty.textContent).toContain("Банош з бринзою");
    fireEvent.click(within(empty).getByRole("button", { name: "Додати розділ «Страви»" }));
    await flush();
    // Типовой раздел — на uk и en, независимо от языка интерфейса.
    expect(createPriceSection).toHaveBeenCalledWith(PLACE, { uk: "Страви", en: "Dishes" });
    expect(screen.getByTestId("prices-message").textContent).toContain("Розділ додано.");
    expect(screen.getByRole("heading", { level: 2, name: /Страви/ })).toBeTruthy();
    expect(screen.getByText("У розділі ще немає позицій.")).toBeTruthy();
  });

  it("«+ Позиція» → лист: без назви і з невірною ціною — підказка; збереження в копійках", async () => {
    const createPriceItem = vi.fn(async () =>
      listOf([
        food([
          priceItem({ name: { uk: "Чан" }, priceMinor: 150050, priceFrom: true, unit: { uk: "за годину" } }),
        ]),
      ]),
    );
    setup(<PartnerPriceList placeId={PLACE} />, { priceList: async () => listOf([food()]), createPriceItem });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Додати позицію в розділ «Страви»" }));
    const sheet = screen.getByRole("dialog", { name: "Нова позиція" });
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Назва"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    expect(within(sheet).getByRole("alert").textContent).toBe("Вкажіть назву.");
    fireEvent.change(within(sheet).getByLabelText("Назва"), { target: { value: "Чан" } });
    fireEvent.change(within(sheet).getByLabelText("Ціна, грн"), { target: { value: "15ab" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    expect(within(sheet).getByRole("alert").textContent).toContain("Вкажіть ціну числом");
    expect(createPriceItem).not.toHaveBeenCalled();
    fireEvent.change(within(sheet).getByLabelText("Ціна, грн"), { target: { value: "1500,5" } });
    fireEvent.click(within(sheet).getByLabelText("Ціна «від» (мінімальна)"));
    fireEvent.change(within(sheet).getByLabelText("Одиниця (необов'язково)"), {
      target: { value: "за годину" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    await flush();
    expect(createPriceItem).toHaveBeenCalledWith(PLACE, {
      sectionId: S1,
      name: { uk: "Чан" },
      priceMinor: 150050,
      priceFrom: true,
      unit: { uk: "за годину" },
      description: null,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("prices-message").textContent).toContain("Позицію додано.");
    const row = screen.getByTestId("price-item");
    expect(norm(row.textContent)).toContain("від 1 500,50 грн за годину");
  });

  it("тап по позиції → правка зі збереженням перекладів і версією; приховати; ▲▼ і крайні вимкнені", async () => {
    const a = priceItem({ id: "a", name: { uk: "Банош", en: "Banosh" }, version: 3, priceFrom: true });
    const b = priceItem({ id: "b", name: { uk: "Деруни" }, sortOrder: 1 });
    const updatePriceItem = vi.fn(async () => listOf([food([{ ...a, hidden: true, version: 4 }, b])]));
    const movePriceItem = vi.fn(async () => listOf([food([b, a])]));
    setup(<PartnerPriceList placeId={PLACE} />, {
      priceList: async () => listOf([food([a, b])]),
      updatePriceItem,
      movePriceItem,
    });
    await flush();
    expect(screen.getByRole("button", { name: "«Банош» вище" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "«Деруни» нижче" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Банош/ }));
    const sheet = screen.getByRole("dialog", { name: "Редагування позиції" });
    // Фокус — на названии, а не на отмеченном чекбоксе «від».
    expect(document.activeElement).toBe(within(sheet).getByLabelText("Назва"));
    expect((within(sheet).getByLabelText("Ціна, грн") as HTMLInputElement).value).toBe("180");
    fireEvent.click(within(sheet).getByLabelText("Приховати від туристів"));
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    await flush();
    expect(updatePriceItem).toHaveBeenCalledWith(PLACE, "a", {
      name: { uk: "Банош", en: "Banosh" },
      priceMinor: 18000,
      priceFrom: true,
      unit: null,
      description: null,
      hidden: true,
      version: 3,
    });
    expect(screen.getAllByTestId("price-item")[0]!.textContent).toContain("Приховано");
    fireEvent.click(screen.getByRole("button", { name: "«Деруни» вище" }));
    await flush();
    expect(movePriceItem).toHaveBeenCalledWith(PLACE, "b", "up");
    expect(screen.getAllByTestId("price-item").map((r) => r.querySelector("strong")!.textContent)).toEqual([
      "Деруни",
      "Банош",
    ]);
  });

  it("розділ: згорнути/розгорнути, приховати, ▲▼, до архіву з підтвердженням", async () => {
    const drinks = { ...food([], { id: S2, title: { uk: "Напої" }, sortOrder: 1 }) };
    const updatePriceSection = vi.fn(async () => listOf([food([], { hidden: true, version: 2 }), drinks]));
    const movePriceSection = vi.fn(async () => listOf([drinks, food()]));
    const archivePriceSection = vi.fn(async () => listOf([food()]));
    setup(<PartnerPriceList placeId={PLACE} />, {
      priceList: async () => listOf([food([priceItem({})]), drinks]),
      updatePriceSection,
      movePriceSection,
      archivePriceSection,
    });
    await flush();
    const toggle = screen.getByRole("button", { name: /Страви/, expanded: true });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Банош")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Приховати розділ «Страви» від туристів" }));
    await flush();
    expect(updatePriceSection).toHaveBeenCalledWith(PLACE, S1, { hidden: true, version: 1 });
    expect(screen.getByRole("button", { name: "Показати розділ «Страви» туристам" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Розділ «Напої» вище" }));
    await flush();
    expect(movePriceSection).toHaveBeenCalledWith(PLACE, S2, "up");
    fireEvent.click(screen.getByRole("button", { name: "Розділ «Напої» до архіву" }));
    fireEvent.click(screen.getByRole("button", { name: "Так, до архіву разом із позиціями" }));
    await flush();
    expect(archivePriceSection).toHaveBeenCalledWith(PLACE, S2);
    expect(screen.getByTestId("prices-message").textContent).toContain("Перенесено до архіву.");
  });

  it("конфлікт версії — повідомлення й перечитування прайсу", async () => {
    const priceList = vi.fn(async () => listOf([food()]));
    setup(<PartnerPriceList placeId={PLACE} />, {
      priceList,
      updatePriceSection: () => Promise.reject(new ConflictError("errors.priceList.versionConflict")),
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Приховати розділ «Страви» від туристів" }));
    await flush();
    expect(screen.getByTestId("prices-message").textContent).toContain("Прайс змінили з іншого пристрою");
    expect(priceList).toHaveBeenCalledTimes(2);
  });

  it("409 у листі позиції: лист закривається, прайс перечитується, свіжі дані сервера витісняють відповідь зміни", async () => {
    const mine = priceItem({ id: "a", name: { uk: "Банош" }, version: 1 });
    const theirs = priceItem({ id: "a", name: { uk: "Банош з бринзою" }, priceMinor: 20000, version: 2 });
    let server = listOf([food()]);
    const priceList = vi.fn(async () => server);
    const createPriceItem = vi.fn(async () => listOf([food([mine])]));
    const updatePriceItem = vi.fn(() =>
      Promise.reject(new ConflictError("errors.priceList.versionConflict")),
    );
    setup(<PartnerPriceList placeId={PLACE} />, { priceList, createPriceItem, updatePriceItem });
    await flush();
    // Изменение — ответ показан вместо загруженного.
    fireEvent.click(screen.getByRole("button", { name: "Додати позицію в розділ «Страви»" }));
    let sheet = screen.getByRole("dialog", { name: "Нова позиція" });
    fireEvent.change(within(sheet).getByLabelText("Назва"), { target: { value: "Банош" } });
    fireEvent.change(within(sheet).getByLabelText("Ціна, грн"), { target: { value: "180" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    await flush();
    expect(screen.getByTestId("price-item").textContent).toContain("Банош");
    // С другого устройства позицию изменили: сохранение — 409.
    server = listOf([food([theirs])]);
    fireEvent.click(screen.getByRole("button", { name: /^Банош/ }));
    sheet = screen.getByRole("dialog", { name: "Редагування позиції" });
    fireEvent.change(within(sheet).getByLabelText("Ціна, грн"), { target: { value: "190" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    await flush();
    expect(updatePriceItem).toHaveBeenCalledWith(PLACE, "a", expect.objectContaining({ version: 1 }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("prices-message").textContent).toContain(
      "Прайс змінили з іншого пристрою — перевірте і збережіть ще раз.",
    );
    expect(priceList).toHaveBeenCalledTimes(2);
    expect(norm(screen.getByTestId("price-item").textContent)).toContain("Банош з бринзою200 грн");
    // Повторное открытие — свежая версия, следующее сохранение уйдёт с version 2.
    fireEvent.click(screen.getByRole("button", { name: /^Банош з бринзою/ }));
    sheet = screen.getByRole("dialog", { name: "Редагування позиції" });
    expect((within(sheet).getByLabelText("Ціна, грн") as HTMLInputElement).value).toBe("200");
    fireEvent.click(within(sheet).getByRole("button", { name: "Зберегти" }));
    await flush();
    expect(updatePriceItem).toHaveBeenLastCalledWith(PLACE, "a", expect.objectContaining({ version: 2 }));
  });

  it("касир — «Прайсом керують власник і менеджер закладу», без запиту правок", async () => {
    setup(<PartnerPriceList placeId={PLACE} />, { priceList: async () => listOf([]) }, "ORG_STAFF");
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Прайсом керують власник і менеджер закладу.");
    expect(screen.queryByTestId("prices-empty")).toBeNull();
  });
});
