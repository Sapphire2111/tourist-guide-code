// AD02 «Заявки на заклад» (0031): вкладка, очередь, карточка с телефоном Google и заявителя, решения, 409.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./App.js";
import { createAdminApi, setToken } from "./api.js";
import { safeHref, telHref } from "./Claims.js";

const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const CLAIM_ID = "00000000-0000-4000-8000-000000000b01";
const PLACE_ID = "00000000-0000-4000-8000-000000000b02";
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
const CLAIM = {
  id: CLAIM_ID,
  regionId: REGION_ID,
  placeId: PLACE_ID,
  placeName: { uk: "Wood Stone" },
  role: "owner",
  status: "pending",
  organizationId: null,
  organizationName: "ФОП Гуцул",
  decisionComment: null,
  createdAt: "2026-11-05T10:00:00Z",
  decidedAt: null,
  userId: "00000000-0000-4000-8000-000000000b03",
  claimantName: "Олена",
  claimantUsername: "olena",
  newOrganization: true,
  decidedByName: null,
  own: false,
};
const DETAIL = {
  ...CLAIM,
  phone: "+380501112233",
  phoneSource: "telegram_contact",
  comment: "Я власниця",
  place: {
    id: PLACE_ID,
    name: { uk: "Wood Stone" },
    status: "published",
    source: "google",
    address: "вулиця Свободи, 59/3, Яремче",
    phone: "+380983001120",
    website: "https://woodstone.example/",
    googleMapsUri: "https://maps.google.com/?cid=1",
    category: "Ресторани",
    organizationName: null,
  },
  otherClaims: [
    {
      ...CLAIM,
      id: "00000000-0000-4000-8000-000000000b04",
      claimantName: "Іван",
      organizationName: "ТОВ Інше",
    },
  ],
};
const envelope = (code: string, messageKey: string) => ({ error: { code, messageKey, correlationId: "x" } });

type Handler = (method: string, path: string, body: unknown) => [number, unknown] | undefined;

function fakeApi(handler: Handler) {
  const calls: { method: string; path: string; body: unknown; query: string }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path: url.pathname, body, query: url.search });
    const fallback: [number, unknown] =
      url.pathname === "/auth/session"
        ? [200, SESSION]
        : url.pathname === "/admin/moderation/claims"
          ? [200, { items: [CLAIM] }]
          : url.pathname === `/admin/moderation/claims/${CLAIM_ID}`
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

describe("ссылки карточки заявки", () => {
  it("только http(s) и номер телефона", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://a.example/")).toBe("https://a.example/");
    expect(telHref("+380 98 300-11-20")).toBe("tel:+380983001120");
    expect(telHref("abc")).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});

describe("заявки на заклад", () => {
  it("вкладка в модерации; очередь pending со ссылкой на заявку и новой организацией", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api, "#/moderation");
    const tab = screen.getByRole("link", { name: "Заявки на заклад" });
    expect(tab.getAttribute("href")).toBe("#/moderation/claims");
    window.location.hash = "#/moderation/claims";
    await flush();
    await flush();
    expect(calls.find((c) => c.path === "/admin/moderation/claims")?.query).toContain("status=pending");
    expect(screen.getByRole("link", { name: "Заявки на заклад" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Wood Stone" }).getAttribute("href")).toBe(
      `#/moderation/claims/${CLAIM_ID}`,
    );
    expect(screen.getByText("нова: ФОП Гуцул")).toBeDefined();
  });

  it("карточка: телефон Google (tel:), Google Maps, телефон заявителя, конкуренты; схвалити — POST approve", async () => {
    const { api, calls } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/approve") ? [200, { ...CLAIM, status: "approved" }] : undefined,
    );
    await open(api, `#/moderation/claims/${CLAIM_ID}`);
    expect(screen.getByRole("link", { name: "+380983001120" }).getAttribute("href")).toBe(
      "tel:+380983001120",
    );
    expect(screen.getByRole("link", { name: "Відкрити в Google Maps" }).getAttribute("href")).toBe(
      "https://maps.google.com/?cid=1",
    );
    expect(screen.getByRole("link", { name: "+380501112233" })).toBeDefined();
    expect(screen.getByText(/з Telegram/)).toBeDefined();
    expect(
      screen.getByText("Схвалення цієї заявки автоматично відхилить інші заявки на розгляді."),
    ).toBeDefined();
    const form = screen.getByRole("form", { name: "Схвалити" });
    fireEvent.change(within(form).getByLabelText("Коментар (необов'язково)"), {
      target: { value: " Подзвонила " },
    });
    fireEvent.submit(form);
    await flush();
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: `/admin/moderation/claims/${CLAIM_ID}/approve`,
      body: { comment: "Подзвонила" },
    });
    expect(screen.getByText("Заявку схвалено: заклад закріплено за організацією заявника.")).toBeDefined();
  });

  it("відхилити без причини — ошибка без запроса; 409 — перечитать заявку", async () => {
    let decided = false;
    const { api, calls } = fakeApi((m, p) => {
      if (m === "POST" && p.endsWith("/reject")) {
        decided = true;
        return [409, envelope("CONFLICT", "errors.placeClaim.alreadyDecided")];
      }
      if (p === `/admin/moderation/claims/${CLAIM_ID}` && decided)
        return [
          200,
          { ...DETAIL, status: "rejected", decisionComment: "Інший модератор", decidedByName: "Петро" },
        ];
      return undefined;
    });
    await open(api, `#/moderation/claims/${CLAIM_ID}`);
    const form = screen.getByRole("form", { name: "Відхилити" });
    fireEvent.submit(form);
    await flush();
    expect(within(form).getByRole("alert").textContent).toBe("Вкажіть причину — партнер її побачить.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(form).getByLabelText("Причина відмови (бачить заявник)"), {
      target: { value: "Не дозвонились" },
    });
    fireEvent.submit(form);
    await flush();
    await flush();
    await flush();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "Не дозвонились" });
    expect(screen.getByText("Коментар модератора: Інший модератор")).toBeDefined();
    expect(screen.queryByRole("form", { name: "Відхилити" })).toBeNull();
  });

  it("своя заявка — без форм решения", async () => {
    const { api } = fakeApi((_m, p) =>
      p === `/admin/moderation/claims/${CLAIM_ID}` ? [200, { ...DETAIL, own: true }] : undefined,
    );
    await open(api, `#/moderation/claims/${CLAIM_ID}`);
    expect(screen.getByText(/рішення ухвалює інший модератор/)).toBeDefined();
    expect(screen.queryByRole("form", { name: "Схвалити" })).toBeNull();
  });
});
