// Правки проверки 3C: одна мутация за раз, 401 в работе и при старте, «Про заклад», журнал, фото, подписи полей.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./App.js";
import { createAdminApi, getToken, setToken } from "./api.js";
import { dayStartIso } from "./dates.js";
import { uploadProblem } from "./PlaceMedia.js";

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
const REGION = {
  id: REGION_ID,
  code: "test-region",
  name: { uk: "Тестовий регіон" },
  status: "active",
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
  updatedAt: "2026-11-02T00:00:00Z",
};
const QR = {
  id: "00000000-0000-4000-8000-000000000301",
  regionId: REGION_ID,
  code: "abcdefghij12",
  type: "region",
  label: "Стенд",
  campaign: null,
  source: null,
  placeId: null,
  active: true,
  venue: null,
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
};
const envelope = (code: string, messageKey: string, details?: unknown) => ({
  error: { code, messageKey, ...(details ? { details } : {}), correlationId: "x" },
});

type Reply = [number, unknown] | Promise<[number, unknown]>;
type Handler = (method: string, path: string, url: URL) => Reply | undefined;

function fakeApi(handler: Handler) {
  const calls: { method: string; path: string; url: URL }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    calls.push({ method: req.method, path: url.pathname, url });
    const fallback: [number, unknown] =
      url.pathname === "/auth/session"
        ? [200, SESSION]
        : url.pathname === "/admin/regions"
          ? [200, { items: [REGION] }]
          : url.pathname.startsWith("/admin/")
            ? [200, { items: [], nextCursor: null }]
            : [404, envelope("NOT_FOUND", "errors.notFound")];
    const [status, json] = await (handler(req.method, url.pathname, url) ?? fallback);
    return new Response(status === 204 ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createAdminApi("http://api.test", fetch as unknown as typeof globalThis.fetch), calls };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => setToken("tok"));
afterEach(() => {
  cleanup();
  window.location.hash = "";
  setToken(null);
});

async function openQrForm(api: ReturnType<typeof fakeApi>["api"]) {
  window.location.hash = "#/qr";
  render(<App api={api} />);
  await flush();
  return screen.getByRole("form", { name: "Новий QR-код" });
}

describe("одна мутация за раз", () => {
  it("двойной клик и Enter по «Створити» QR во время запроса — один POST", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, calls } = fakeApi((m, p) =>
      m === "POST" && p === "/admin/qr-points" ? gate.then(() => [201, QR] as [number, unknown]) : undefined,
    );
    const form = await openQrForm(api);
    fireEvent.change(within(form).getByLabelText("Тип"), { target: { value: "region" } });
    fireEvent.change(within(form).getByLabelText(/^Підпис/), { target: { value: "Стенд" } });
    const submit = within(form).getByRole("button", { name: "Створити" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);
    await flush();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    release();
    await flush();
    await flush();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/admin/qr-points")).toHaveLength(1);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("сессия", () => {
  it("401 в работе — токен сброшен, вход с «сесія завершилась»", async () => {
    const { api } = fakeApi((m, p) =>
      p === "/admin/regions" ? [401, envelope("UNAUTHENTICATED", "errors.unauthenticated")] : undefined,
    );
    render(<App api={api} />);
    await flush();
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeDefined();
    expect(screen.getByText("Сесія завершилась — увійдіть знову.")).toBeDefined();
    expect(getToken()).toBeNull();
  });

  it("старт: 500 на /auth/session — ошибка и «Повторити», токен остаётся", async () => {
    let down = true;
    const { api } = fakeApi((m, p) =>
      p === "/auth/session" && down ? [500, envelope("INTERNAL", "errors.internal")] : undefined,
    );
    render(<App api={api} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Внутрішня помилка сервера.");
    expect(getToken()).toBe("tok");
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторити" }));
    await flush();
    expect(screen.getByRole("navigation", { name: "Розділи" })).toBeDefined();
  });

  it("старт: сбой сети — сообщение о недоступности, токен остаётся", async () => {
    const { api } = fakeApi((m, p) =>
      p === "/auth/session" ? Promise.reject(new Error("offline")) : undefined,
    );
    render(<App api={api} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Сервер недоступний");
    expect(getToken()).toBe("tok");
  });
});

describe("QR", () => {
  it("«Про заклад» без названия — ошибка формы, запроса нет", async () => {
    const { api, calls } = fakeApi(() => undefined);
    const form = await openQrForm(api);
    fireEvent.change(within(form).getByLabelText(/^Підпис/), { target: { value: "Ресепшн" } });
    const venue = within(form).getByRole("group", { name: "Про заклад (для готелю)" });
    fireEvent.change(within(venue).getByLabelText("Телефон"), { target: { value: "+380501234567" } });
    fireEvent.click(within(form).getByRole("button", { name: "Створити" }));
    await flush();
    expect(within(form).getByRole("alert").textContent).toContain("Заповніть назву закладу");
    expect(calls.some((c) => c.method === "POST" && c.path === "/admin/qr-points")).toBe(false);
  });

  it("ошибки полей — подписи полей (откат к родителю и общему «Поле»)", async () => {
    const { api } = fakeApi((m, p) =>
      m === "POST" && p === "/admin/qr-points"
        ? [
            400,
            envelope("VALIDATION_FAILED", "errors.validation", {
              fields: [
                { field: "venue.phone", messageKey: "errors.validation.matches", constraint: "matches" },
                { field: "label", messageKey: "errors.validation.maxLength", constraint: "maxLength" },
                { field: "zzz", messageKey: "errors.validation.isString", constraint: "isString" },
              ],
            }),
          ]
        : undefined,
    );
    const form = await openQrForm(api);
    fireEvent.change(within(form).getByLabelText("Тип"), { target: { value: "region" } });
    fireEvent.change(within(form).getByLabelText(/^Підпис/), { target: { value: "x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Створити" }));
    await flush();
    const text = within(form).getByRole("alert").textContent;
    expect(text).toContain("Телефон закладу: Некоректний формат.");
    expect(text).toContain("Підпис: Занадто довгий текст.");
    expect(text).toContain("Поле: Значення має бути рядком.");
  });
});

describe("журнал и даты", () => {
  it("«по» включительно — начало следующего дня по таймзоне региона", async () => {
    const { api, calls } = fakeApi(() => undefined);
    window.location.hash = "#/audit";
    render(<App api={api} />);
    await flush();
    fireEvent.change(screen.getByLabelText("З дати"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("По дату (включно)"), { target: { value: "2026-07-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Застосувати" }));
    await flush();
    const last = calls.filter((c) => c.path === "/admin/audit-logs").at(-1)!;
    // Киев летом UTC+3: сутки 1 июля — [30.06 21:00Z; 01.07 21:00Z).
    expect(last.url.searchParams.get("from")).toBe("2026-06-30T21:00:00.000Z");
    expect(last.url.searchParams.get("to")).toBe("2026-07-01T21:00:00.000Z");
  });

  it("dayStartIso: зима/лето и день перехода на летнее время", () => {
    expect(dayStartIso("2026-01-15", "Europe/Kyiv")).toBe("2026-01-14T22:00:00.000Z");
    expect(dayStartIso("2026-07-01", "Europe/Kyiv")).toBe("2026-06-30T21:00:00.000Z");
    expect(dayStartIso("2026-03-29", "Europe/Kyiv")).toBe("2026-03-28T22:00:00.000Z");
    expect(dayStartIso("2026-03-29", "Europe/Kyiv", 1)).toBe("2026-03-29T21:00:00.000Z");
  });

  it("uploadProblem: тип, размер и alt проверяются до загрузки", () => {
    const file = (type: string, size: number) => new File([new Uint8Array(size)], "x", { type });
    const alt = { uk: "Фасад", en: "" };
    expect(uploadProblem(null, alt)).toBe("admin.media.fileRequired");
    expect(uploadProblem(file("image/gif", 10), alt)).toBe("admin.media.typeInvalid");
    expect(uploadProblem(file("image/png", 0), alt)).toBe("admin.media.sizeInvalid");
    expect(uploadProblem(file("image/png", 10), { uk: " ", en: "" })).toBe("admin.media.altRequired");
    expect(uploadProblem(file("image/png", 10), { uk: "a".repeat(301), en: "" })).toBe(
      "admin.media.altTooLong",
    );
    expect(uploadProblem(file("image/webp", 10), alt)).toBeNull();
  });
});
