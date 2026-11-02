// Модерація партнерів (блок 6): очередь, решения, обязательные поля, 403/409.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./App.js";
import { createAdminApi, setToken } from "./api.js";
import { mapUrl, reasonBody, safeImageUrl } from "./Moderation.js";

const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const CASE_ID = "00000000-0000-4000-8000-000000000901";
const SESSION = {
  id: "00000000-0000-4000-8000-0000000000e1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  channel: "admin_web",
  expiresAt: "2099-01-01T00:00:00Z",
  activeRegionId: null,
  grants: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "MODERATOR",
      scopeType: "REGION",
      scopeId: REGION_ID,
      regionId: REGION_ID,
      validUntil: null,
    },
  ],
};
const CASE = {
  id: CASE_ID,
  regionId: REGION_ID,
  placeId: "00000000-0000-4000-8000-000000000902",
  placeName: { uk: "Кафе Говерла" },
  placeStatus: "pending_moderation",
  organizationId: "00000000-0000-4000-8000-000000000903",
  organizationName: "ФОП Іваненко",
  templateCode: "cafe",
  templateName: { uk: "Кафе" },
  decidedByName: null,
  ownOrganization: false,
  status: "open",
  decision: null,
  comment: null,
  verificationMethod: null,
  submittedBy: "00000000-0000-4000-8000-000000000904",
  submittedByName: "Олена",
  submittedAt: "2026-11-02T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
};
const DETAIL = {
  ...CASE,
  placeSnapshot: { name: { uk: "Кафе Говерла" }, address: { uk: "вул. Гірська, 1" } },
  partnerNote: null,
  owners: [{ userId: CASE.submittedBy, displayName: "Олена", username: "olena_cafe" }],
  history: [],
  publishProblems: [],
  possibleDuplicates: [],
  snapshotMediaPreview: {},
};
const envelope = (code: string, messageKey: string, details?: unknown) => ({
  error: { code, messageKey, ...(details ? { details } : {}), correlationId: "x" },
});

type Handler = (method: string, path: string, body: unknown) => [number, unknown] | undefined;

function fakeApi(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path: url.pathname, body });
    const fallback: [number, unknown] =
      url.pathname === "/auth/session"
        ? [200, SESSION]
        : url.pathname === "/admin/moderation/cases"
          ? [200, { items: [CASE] }]
          : url.pathname === `/admin/moderation/cases/${CASE_ID}`
            ? [200, DETAIL]
            : url.pathname.startsWith("/admin/")
              ? [200, { items: [], nextCursor: null }]
              : [404, envelope("NOT_FOUND", "errors.notFound")];
    const [status, json] = handler(req.method, url.pathname, body) ?? fallback;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
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

async function open(api: ReturnType<typeof fakeApi>["api"], hash: string) {
  window.location.hash = hash;
  render(<App api={api} />);
  await flush();
  await flush();
}

describe("reasonBody", () => {
  it("пустая и из пробелов — null, иначе обрезанная", () => {
    expect(reasonBody("")).toBeNull();
    expect(reasonBody("   ")).toBeNull();
    expect(reasonBody("  Додайте фото ")).toEqual({ reason: "Додайте фото" });
  });
});

describe("модерація", () => {
  it("черга: запрос со статусом open, заявка со ссылкой на карточку", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api, "#/moderation");
    const list = calls.find((c) => c.path === "/admin/moderation/cases");
    expect(list).toBeDefined();
    const link = screen.getByRole("link", { name: "Кафе Говерла" });
    expect(link.getAttribute("href")).toBe(`#/moderation/${CASE_ID}`);
    expect(screen.getByText("ФОП Іваненко")).toBeDefined();
  });

  it("403 на очереди — понятный текст, а не сырая ошибка", async () => {
    const { api } = fakeApi((_m, p) =>
      p === "/admin/moderation/cases" ? [403, envelope("FORBIDDEN", "errors.forbidden")] : undefined,
    );
    await open(api, "#/moderation");
    expect(screen.getByRole("alert").textContent).toBe("Немає права модерувати заявки цього регіону.");
  });

  it("«Відхилити» без причины — ошибка, запроса нет; с причиной — POST reject", async () => {
    const { api, calls } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/reject")
        ? [200, { ...CASE, status: "decided", decision: "reject" }]
        : undefined,
    );
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Відхилити" });
    fireEvent.submit(form);
    await flush();
    expect(within(form).getByRole("alert").textContent).toBe("Вкажіть причину — партнер її побачить.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(form).getByLabelText(/^Причина відмови/), {
      target: { value: "Не підтверджено" },
    });
    fireEvent.submit(form);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/admin/moderation/cases/${CASE_ID}/reject`);
    expect(post?.body).toEqual({ reason: "Не підтверджено" });
  });

  it("«Схвалити» требует способ проверки; тело содержит verificationMethod", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Схвалити" });
    fireEvent.submit(form);
    await flush();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(form).getByLabelText(/^Спосіб підтвердження/), {
      target: { value: "phone_call" },
    });
    fireEvent.submit(form);
    await flush();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ verificationMethod: "phone_call" });
  });

  it("409 — «вже розглянув інший модератор»", async () => {
    const { api } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/return")
        ? [409, envelope("CONFLICT", "errors.moderation.alreadyDecided")]
        : undefined,
    );
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Повернути на доопрацювання" });
    fireEvent.change(within(form).getByLabelText(/^Що виправити/), { target: { value: "Додайте фото" } });
    fireEvent.submit(form);
    await flush();
    expect(screen.getByText(/уже|вже розглянув інший модератор/)).toBeDefined();
  });
});

describe("правки по проверке", () => {
  it("успех: сообщение остаётся после перехода заявки в decided", async () => {
    let decided = false;
    const { api } = fakeApi((m, p) => {
      if (m === "POST" && p.endsWith("/approve")) {
        decided = true;
        return [200, { ...CASE, status: "decided", decision: "approve" }];
      }
      if (decided && p === `/admin/moderation/cases/${CASE_ID}`)
        return [200, { ...DETAIL, status: "decided", decision: "approve", verificationMethod: "document" }];
      return undefined;
    });
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Схвалити" });
    fireEvent.change(within(form).getByLabelText(/^Спосіб підтвердження/), { target: { value: "document" } });
    fireEvent.submit(form);
    await flush();
    await flush();
    expect(screen.queryByRole("form", { name: "Схвалити" })).toBeNull();
    expect(screen.getByText("Заклад схвалено й опубліковано.")).toBeDefined();
  });

  it("409 «не на модерации» — свой текст, не «вже розглянув»", async () => {
    const { api } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/reject")
        ? [409, envelope("CONFLICT", "errors.moderation.notPending", { reason: "place_not_pending" })]
        : undefined,
    );
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Відхилити" });
    fireEvent.change(within(form).getByLabelText(/^Причина відмови/), { target: { value: "Дубль" } });
    fireEvent.submit(form);
    await flush();
    expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("уже не очікує модерації"))).toBe(
      true,
    );
    expect(screen.queryByText(/вже розглянув інший модератор/)).toBeNull();
  });

  it("двойная отправка формы решения — один POST", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, calls } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/reject")
        ? (gate.then(() => [200, { ...CASE, status: "decided" }] as [number, unknown]) as never)
        : undefined,
    );
    await open(api, `#/moderation/${CASE_ID}`);
    const form = screen.getByRole("form", { name: "Відхилити" });
    fireEvent.change(within(form).getByLabelText(/^Причина відмови/), { target: { value: "Дубль" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await flush();
    release();
    await flush();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("mapUrl и safeImageUrl", () => {
    expect(mapUrl({ lat: 48.45, lon: 24.55 })).toContain("mlat=48.45&mlon=24.55");
    expect(mapUrl(null)).toBeNull();
    expect(mapUrl({ lat: "x", lon: 1 })).toBeNull();
    expect(safeImageUrl("https://cdn.test/a.jpg")).toBe("https://cdn.test/a.jpg");
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
  });
});

describe("поля 6A", () => {
  it("дубли, шаблон по названию и пометка своей организации; форм решения нет", async () => {
    const { api } = fakeApi((m, p) =>
      m === "GET" && p === `/admin/moderation/cases/${CASE_ID}`
        ? [
            200,
            {
              ...DETAIL,
              ownOrganization: true,
              possibleDuplicates: [
                {
                  id: "00000000-0000-4000-8000-000000000999",
                  name: { uk: "Кафе Говерла (Google)" },
                  status: "published",
                  source: "google",
                  distanceMeters: 30,
                },
              ],
            },
          ]
        : undefined,
    );
    await open(api, `#/moderation/${CASE_ID}`);
    expect(screen.getByRole("heading", { name: "Можливі дублікати" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Кафе Говерла (Google)" }).getAttribute("href")).toBe(
      "#/places/00000000-0000-4000-8000-000000000999",
    );
    expect(screen.getByText("Шаблон: Кафе")).toBeDefined();
    expect(screen.queryByRole("form", { name: "Схвалити" })).toBeNull();
  });
});
