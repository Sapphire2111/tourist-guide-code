import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App, SECTIONS, type Section } from "./App.js";
import { createAdminApi, getToken, setToken, TOKEN_KEY, toApiError } from "./api.js";
import { placeBody } from "./PlaceEditor.js";
import { qrBody } from "./Qr.js";

const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const SESSION = {
  id: "00000000-0000-4000-8000-0000000000e1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  channel: "admin_web",
  expiresAt: "2099-01-01T00:00:00Z",
  activeRegionId: null,
  grants: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "REGION_ADMIN",
      scopeType: "REGION",
      scopeId: REGION_ID,
      regionId: REGION_ID,
      validUntil: null,
    },
  ],
};
const PLACE = {
  id: "00000000-0000-4000-8000-000000000101",
  status: "draft",
  categoryId: "00000000-0000-4000-8000-000000000201",
  localityId: null,
  name: { uk: "Кав'ярня" },
  description: null,
  address: null,
  location: null,
  phone: null,
  website: null,
  telegram: null,
  recommended: false,
  verifiedAt: null,
  tagIds: [],
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
};

type Handler = (method: string, path: string, body: unknown) => [number, unknown] | undefined;

/** Клиент с подменённым fetch: обработчик → [статус, тело]; не найдено — 404 с конвертом. */
function fakeApi(handler: Handler) {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    const text = await req.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    calls.push({ method: req.method, path, auth: req.headers.get("Authorization"), body });
    const [status, json] = handler(req.method, path, body) ?? [
      404,
      { error: { code: "NOT_FOUND", messageKey: "errors.notFound", correlationId: "x" } },
    ];
    return new Response(status === 204 ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createAdminApi("http://api.test", fetch as unknown as typeof globalThis.fetch), calls };
}

/** Обработчик «вошедшего» админа: сессия и пустые справочники. */
const loggedIn =
  (extra: Handler = () => undefined): Handler =>
  (m, p, b) =>
    extra(m, p, b) ??
    (p === "/auth/session"
      ? [200, SESSION]
      : p === "/admin/regions"
        ? [200, { items: [] }]
        : p.startsWith("/admin/")
          ? [200, { items: [], nextCursor: null }]
          : undefined);

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  setToken(null);
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
  setToken(null);
});

describe("вход", () => {
  it("без токена — форма входа; 401 — одно сообщение «невірний логін або пароль»", async () => {
    const { api } = fakeApi((m, p) =>
      p === "/auth/admin/login"
        ? [
            401,
            { error: { code: "UNAUTHENTICATED", messageKey: "errors.unauthenticated", correlationId: "x" } },
          ]
        : undefined,
    );
    render(<App api={api} />);
    expect(screen.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Логін"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Увійти" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Неправильний логін або пароль.");
    expect((screen.getByLabelText("Пароль") as HTMLInputElement).value).toBe("");
    expect(getToken()).toBeNull();
  });

  it("успех: токен в sessionStorage, Bearer на запросы, меню; выход — токен удалён", async () => {
    const { api, calls } = fakeApi(
      loggedIn((m, p) =>
        p === "/auth/admin/login" ? [201, { token: "tok-1", session: SESSION }] : undefined,
      ),
    );
    render(<App api={api} />);
    fireEvent.change(screen.getByLabelText("Логін"), { target: { value: " admin " } });
    fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Увійти" }));
    await flush();
    expect(calls[0]).toMatchObject({
      path: "/auth/admin/login",
      body: { login: "admin", password: "secret-password" },
    });
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    const nav = screen.getByRole("navigation", { name: "Розділи" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "Регіон",
      "Населені пункти",
      "Категорії та теги",
      "Місця",
      "Модерація",
      "QR-коди",
      "Сценарії «Мій план»",
      "Екстрені контакти",
      "Аудит",
    ]);
    expect(calls.find((c) => c.path === "/admin/regions")?.auth).toBe("Bearer tok-1");
    // Регион-админ одного региона — выбора региона нет.
    expect(screen.queryByLabelText("Регіон роботи")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Вийти" }));
    await flush();
    expect(getToken()).toBeNull();
    expect(calls.some((c) => c.path === "/auth/admin/logout")).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeDefined();
  });

  it("сохранённый токен устарел (401 на /auth/session) — форма входа, токен удалён", async () => {
    setToken("old");
    const { api } = fakeApi((m, p) =>
      p === "/auth/session"
        ? [
            401,
            { error: { code: "UNAUTHENTICATED", messageKey: "errors.unauthenticated", correlationId: "x" } },
          ]
        : undefined,
    );
    render(<App api={api} />);
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeDefined();
    expect(getToken()).toBeNull();
  });

  it("SUPERADMIN (PLATFORM): выбор региона — PUT /auth/session/region", async () => {
    setToken("tok");
    const platform = {
      ...SESSION,
      grants: [
        { ...SESSION.grants[0], role: "SUPERADMIN", scopeType: "PLATFORM", scopeId: null, regionId: null },
      ],
    };
    const { api, calls } = fakeApi(
      loggedIn((m, p, b) =>
        p === "/auth/session"
          ? [200, platform]
          : p === "/admin/regions"
            ? [
                200,
                {
                  items: [
                    {
                      id: REGION_ID,
                      code: "test-region",
                      name: { uk: "Тестовий регіон" },
                      status: "active",
                      timezone: "Europe/Kyiv",
                      defaultLanguage: "uk",
                      updatedAt: "2026-11-02T00:00:00Z",
                    },
                  ],
                },
              ]
            : p === "/auth/session/region"
              ? [200, { ...platform, activeRegionId: (b as { regionId: string }).regionId }]
              : undefined,
      ),
    );
    render(<App api={api} />);
    await flush();
    expect(screen.getByRole("note").textContent).toContain("Оберіть регіон");
    fireEvent.change(screen.getByLabelText("Регіон роботи"), { target: { value: REGION_ID } });
    // Применяется только кнопкой — выбор в списке запроса не шлёт.
    await flush();
    expect(calls.some((c) => c.path === "/auth/session/region")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Застосувати" }));
    await flush();
    expect(calls.find((c) => c.path === "/auth/session/region")?.body).toEqual({ regionId: REGION_ID });
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("навигация", () => {
  it("переход по hash открывает раздел; неизвестный путь — «не найдено»", async () => {
    setToken("tok");
    const { api } = fakeApi(loggedIn());
    render(<App api={api} />);
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Регіон" })).toBeDefined();
    await act(async () => {
      window.location.hash = "#/audit";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Аудит" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Аудит" }).getAttribute("aria-current")).toBe("page");
    await act(async () => {
      window.location.hash = "#/nope";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeDefined();
  });

  it("раздел модуля за фича-флагом: выключен — нет в меню; включён — есть", async () => {
    setToken("tok");
    const sections: Section[] = [
      ...SECTIONS,
      { path: "/bookings", title: "admin.users", flag: "module.bookings" },
    ];
    const links = () =>
      [...screen.getByRole("navigation").querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const flags of [undefined, { "module.bookings": false }]) {
      const { api } = fakeApi(loggedIn());
      render(<App api={api} sections={sections} flags={flags} />);
      await flush();
      expect(links()).not.toContain("#/bookings");
      cleanup();
    }
    const { api } = fakeApi(loggedIn());
    render(<App api={api} sections={sections} flags={{ "module.bookings": true }} />);
    await flush();
    expect(links()).toContain("#/bookings");
  });
});

describe("места", () => {
  it("публикация: 422 — список причин; после исправления — опубликовано", async () => {
    setToken("tok");
    let fixed = false;
    const { api } = fakeApi(
      loggedIn((m, p) => {
        if (p === `/admin/places/${PLACE.id}` && m === "GET") return [200, PLACE];
        if (p === `/admin/places/${PLACE.id}/publish`)
          return fixed
            ? [200, { ...PLACE, status: "published" }]
            : [
                422,
                {
                  error: {
                    code: "UNPROCESSABLE",
                    messageKey: "errors.place.notPublishable",
                    details: {
                      reason: "not_publishable",
                      problems: ["description_missing", "location_missing"],
                    },
                    correlationId: "x",
                  },
                },
              ];
        if (p.endsWith("/schedule")) return [200, { timezone: "Europe/Kyiv", weekly: [], exceptions: [] }];
        if (p.endsWith("/host-module"))
          return [
            200,
            {
              placeId: PLACE.id,
              regionId: "r1",
              configured: false,
              enabled: false,
              wifiSsid: null,
              wifiPassword: null,
              receptionPhone: null,
              hours: null,
              sections: [],
              services: [],
              updatedAt: null,
            },
          ];
        if (p.endsWith("/staff")) return [200, { items: [] }];
        return undefined;
      }),
    );
    window.location.hash = `#/places/${PLACE.id}`;
    render(<App api={api} />);
    await flush();
    await flush();
    const status = screen.getByRole("region", { name: /Статус: Чернетка/ });
    fireEvent.click(within(status).getByRole("button", { name: "Опублікувати" }));
    await flush();
    const alert = within(status).getByRole("alert");
    expect(alert.textContent).toContain("Місце не можна опублікувати");
    expect(alert.textContent).toContain("Немає опису українською.");
    expect(alert.textContent).toContain("Не вказано точку на карті");
    fixed = true;
    fireEvent.click(within(status).getByRole("button", { name: "Опублікувати" }));
    await flush();
    expect(screen.getByRole("region", { name: /Статус: Опубліковано/ })).toBeDefined();
  });

  it("placeBody: пустые необязательные поля — null, uk обязателен, en по желанию, telegram без @", () => {
    const body = placeBody({
      name: { uk: " Кав'ярня ", en: "" },
      description: { uk: "Опис", en: "Description" },
      address: { uk: "", en: "Street" },
      lat: "48.4",
      lon: "",
      phone: "",
      website: " https://x.example ",
      telegram: "@cafe_demo",
      categoryId: "c",
      localityId: "",
      tagIds: ["t1"],
      extraCategoryIds: ["c", "x1"],
    });
    expect(body).toEqual({
      name: { uk: "Кав'ярня" },
      description: { uk: "Опис", en: "Description" },
      address: null,
      location: null,
      phone: null,
      website: "https://x.example",
      telegram: "cafe_demo",
      categoryId: "c",
      localityId: null,
      tagIds: ["t1"],
      extraCategoryIds: ["x1"],
    });
  });
});

describe("QR и ошибки", () => {
  it("qrBody: «Про заклад» только у hotel с названием; пустые поля не передаются", () => {
    const venue = {
      name: { uk: "Готель", en: "" },
      description: { uk: "", en: "" },
      address: { uk: "вул. 1", en: "" },
      phone: "",
      website: "",
      telegram: "",
    };
    const f = { type: "hotel" as const, label: " Ресепшн ", campaign: "", source: "", placeId: "" };
    expect(qrBody(f, venue)).toEqual({
      type: "hotel",
      label: "Ресепшн",
      campaign: undefined,
      source: undefined,
      placeId: undefined,
      venue: {
        name: { uk: "Готель" },
        description: null,
        address: { uk: "вул. 1" },
        phone: null,
        website: null,
        telegram: null,
      },
    });
    expect(qrBody({ ...f, type: "campaign", campaign: "summer" }, venue).venue).toBeUndefined();
  });

  it("toApiError: конверт → ключ и причины; без конверта — по статусу; сеть — admin.error.network", () => {
    const res = new Response(null, { status: 409 });
    expect(
      toApiError(
        {
          error: {
            messageKey: "errors.qr.botUsernameMissing",
            details: { reason: "bot_username_not_configured" },
          },
        },
        res,
      ),
    ).toEqual({
      status: 409,
      messageKey: "errors.qr.botUsernameMissing",
      problems: ["bot_username_not_configured"],
    });
    expect(toApiError(undefined, new Response(null, { status: 502 })).messageKey).toBe("errors.internal");
    expect(toApiError(undefined, undefined)).toEqual({ status: 0, messageKey: "admin.error.network" });
  });

  it("печать QR: 409 без имени бота — понятное сообщение", async () => {
    setToken("tok");
    const { api } = fakeApi(
      loggedIn((m, p) =>
        p.endsWith("/print")
          ? [
              409,
              {
                error: {
                  code: "CONFLICT",
                  messageKey: "errors.qr.botUsernameMissing",
                  details: { reason: "bot_username_not_configured" },
                  correlationId: "x",
                },
              },
            ]
          : undefined,
      ),
    );
    window.location.hash = "#/qr/00000000-0000-4000-8000-000000000301/print";
    render(<App api={api} />);
    await flush();
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Не налаштовано ім'я бота: друк QR недоступний.");
  });
});
