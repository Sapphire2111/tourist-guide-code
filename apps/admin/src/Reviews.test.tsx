// Модерація відгуків (AD06): фільтри очереди, карточка, решения, апелляции, понятные ошибки.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "./App.js";
import { createAdminApi, setToken } from "./api.js";
import { matchesFilter, reasonOf, serverFilter } from "./Reviews.js";

const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const USER_ID = "00000000-0000-4000-8000-0000000000d1";
const SESSION = {
  id: "00000000-0000-4000-8000-0000000000e1",
  userId: USER_ID,
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
const id = (n: number) => `00000000-0000-4000-8000-00000000090${n}`;
const REVIEW = {
  id: id(1),
  regionId: REGION_ID,
  placeId: id(2),
  placeName: { uk: "Кафе Говерла" },
  organizationId: null,
  authorUserId: id(3),
  authorName: "Олена",
  status: "pending_moderation",
  rating: 4,
  text: "Смачно, дзвоніть 0501234567",
  version: 2,
  autoFlags: ["phone"],
  hiddenReason: null,
  publishedAt: null,
  lastDecisionBy: null,
  lastDecisionAt: null,
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  revisions: [
    { version: 1, rating: 5, text: "Перша версія", autoFlags: [], createdAt: "2026-11-01T10:00:00Z" },
    {
      version: 2,
      rating: 4,
      text: "Смачно, дзвоніть",
      autoFlags: ["phone"],
      createdAt: "2026-11-02T10:00:00Z",
    },
  ],
  complaints: [],
  appeal: null,
  response: {
    id: id(4),
    text: "Дякуємо за відгук!",
    version: 1,
    createdAt: "2026-11-02T11:00:00Z",
    updatedAt: "2026-11-02T11:00:00Z",
  },
  ownOrganization: false,
  canDecideAppeal: false,
  waitingSince: "2026-11-02T10:00:00Z",
};
const COMPLAINT = {
  id: id(5),
  reviewId: REVIEW.id,
  kind: "partner",
  reasonCode: "spam",
  text: "Це реклама",
  status: "open",
  createdAt: "2026-11-03T10:00:00Z",
  decidedAt: null,
};
const APPEAL = {
  id: id(6),
  reviewId: REVIEW.id,
  kind: "author",
  text: "Прошу повернути відгук",
  status: "open",
  decisionNote: null,
  createdAt: "2026-11-03T12:00:00Z",
  decidedAt: null,
};
const APPEALED = {
  ...REVIEW,
  id: id(7),
  status: "hidden",
  placeName: { uk: "Готель Карпати" },
  appeal: APPEAL,
  canDecideAppeal: true,
};
const COMPLAINED = {
  ...REVIEW,
  id: id(8),
  status: "published",
  placeName: { uk: "Піцерія Лука" },
  complaints: [COMPLAINT],
};

const envelope = (code: string, messageKey: string, details?: unknown) => ({
  error: { code, messageKey, ...(details ? { details } : {}), correlationId: "x" },
});

type Handler = (
  method: string,
  path: string,
  body: unknown,
  query: URLSearchParams,
) => [number, unknown] | undefined;

function fakeApi(handler: Handler, items: unknown[] = [REVIEW, APPEALED, COMPLAINED]) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    const fallback: [number, unknown] =
      url.pathname === "/auth/session"
        ? [200, SESSION]
        : url.pathname === "/admin/reviews"
          ? [200, { items }]
          : url.pathname.startsWith("/admin/")
            ? [200, { items: [], nextCursor: null }]
            : [404, envelope("NOT_FOUND", "errors.notFound")];
    const [status, json] = handler(req.method, url.pathname, body, url.searchParams) ?? fallback;
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

async function open(api: ReturnType<typeof fakeApi>["api"]) {
  window.location.hash = "#/reviews";
  render(<App api={api} />);
  await flush();
  await flush();
}

const card = (name: RegExp) => screen.getByRole("article", { name });
const click = async (el: HTMLElement) => {
  fireEvent.click(el);
  await flush();
  await flush();
};

describe("хелперы", () => {
  it("serverFilter и matchesFilter: подфильтры очереди — на клиенте", () => {
    expect(serverFilter("auto")).toBe("queue");
    expect(serverFilter("complaints")).toBe("queue");
    expect(serverFilter("appeals")).toBe("queue");
    expect(serverFilter("hidden")).toBe("hidden");
    expect(matchesFilter(REVIEW as never, "auto")).toBe(true);
    expect(matchesFilter(REVIEW as never, "complaints")).toBe(false);
    expect(matchesFilter(COMPLAINED as never, "complaints")).toBe(true);
    expect(matchesFilter(APPEALED as never, "appeals")).toBe(true);
    expect(matchesFilter(APPEALED as never, "queue")).toBe(true);
  });
  it("reasonOf: пустая — undefined, иначе обрезанная", () => {
    expect(reasonOf("  ")).toBeUndefined();
    expect(reasonOf(" спам ")).toBe("спам");
  });
});

describe("відгуки: черга й картка", () => {
  it("запрос status=queue; карточка: текст, версии, жалобы, ответ партнёра, апелляция", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    expect(calls.find((c) => c.path === "/admin/reviews")?.query).toBe("?status=queue");
    const a = card(/Кафе Говерла/);
    expect(within(a).getByText("Смачно, дзвоніть 0501234567")).toBeDefined();
    expect(within(a).getByText(/Історія версій \(2\)/)).toBeDefined();
    expect(within(a).getByText(/Перша версія/)).toBeDefined();
    expect(within(a).getByText("Дякуємо за відгук!")).toBeDefined();
    expect(within(a).getByText(/Автофільтр: телефон/)).toBeDefined();
    const c = card(/Піцерія Лука/);
    expect(within(c).getByText(/Це реклама/)).toBeDefined();
    expect(within(c).getByText("Відкритих скарг: 1")).toBeDefined();
    expect(within(card(/Готель Карпати/)).getByText("Прошу повернути відгук")).toBeDefined();
  });

  it("фильтр «Апеляції» оставляет только отзывы с открытой апелляцией, запрос тот же queue", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "appeals" } });
    await flush();
    await flush();
    expect(screen.queryByRole("article", { name: /Кафе Говерла/ })).toBeNull();
    expect(screen.getByRole("article", { name: /Готель Карпати/ })).toBeDefined();
    expect(calls.filter((c) => c.path === "/admin/reviews").every((c) => c.query === "?status=queue")).toBe(
      true,
    );
  });

  it("журнал: фильтр «Приховані» идёт на сервер статусом", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    fireEvent.change(screen.getByLabelText("Статус"), { target: { value: "hidden" } });
    await flush();
    await flush();
    expect(calls.at(-1)?.query).toBe("?status=hidden");
  });

  it("пустая очередь и 403", async () => {
    const empty = fakeApi(() => undefined, []);
    await open(empty.api);
    expect(screen.getByText("Відгуків немає.")).toBeDefined();
    cleanup();
    const denied = fakeApi((_m, p) =>
      p === "/admin/reviews" ? [403, envelope("FORBIDDEN", "errors.forbidden")] : undefined,
    );
    await open(denied.api);
    expect(screen.getByRole("alert").textContent).toBe("Немає права модерувати відгуки цього регіону.");
  });
});

describe("відгуки: рішення", () => {
  it("«Відхилити» без причины — ошибка и нет запроса; с причиной — POST hide", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    const form = within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" });
    await click(within(form).getByRole("button", { name: "Відхилити" }));
    expect(within(form).getByRole("alert").textContent).toBe("Вкажіть причину — автор її побачить.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(form).getByLabelText(/^Причина/), { target: { value: "Телефон у тексті" } });
    await click(within(form).getByRole("button", { name: "Відхилити" }));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/admin/reviews/${REVIEW.id}/decision`);
    expect(post?.body).toEqual({ decision: "hide", reason: "Телефон у тексті" });
    expect(screen.getByText("Відгук приховано.")).toBeDefined();
  });

  it("«Схвалити» — POST publish без причины; список перечитывается", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    const form = within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" });
    const before = calls.filter((c) => c.path === "/admin/reviews").length;
    await click(within(form).getByRole("button", { name: "Схвалити" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ decision: "publish" });
    expect(screen.getByText("Відгук опубліковано.")).toBeDefined();
    expect(calls.filter((c) => c.path === "/admin/reviews").length).toBe(before + 1);
  });

  it("опубликованный с жалобой: «Залишити» и «Приховати»; без жалоб «Залишити» нет", async () => {
    const { api } = fakeApi(
      () => undefined,
      [COMPLAINED, { ...COMPLAINED, id: id(9), placeName: { uk: "Кав'ярня" }, complaints: [] }],
    );
    await open(api);
    const withComplaint = within(card(/Піцерія Лука/));
    expect(withComplaint.getByRole("button", { name: /^Залишити/ })).toBeDefined();
    const plain = within(card(/Кав'ярня/));
    expect(plain.queryByRole("button", { name: /^Залишити/ })).toBeNull();
    expect(plain.getByRole("button", { name: "Приховати" })).toBeDefined();
  });

  it("403 own_organization и 409 nothingToDecide — понятные тексты", async () => {
    const { api } = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/decision")
        ? [403, envelope("FORBIDDEN", "errors.forbidden", { reason: "own_organization" })]
        : undefined,
    );
    await open(api);
    const form = within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" });
    await click(within(form).getByRole("button", { name: "Схвалити" }));
    expect(
      within(card(/Кафе Говерла/)).getByText(
        "Не можна розглядати відгук про заклад організації, з якою ви пов'язані.",
      ),
    ).toBeDefined();
    cleanup();
    const second = fakeApi((m, p) =>
      m === "POST" && p.endsWith("/decision")
        ? [409, envelope("CONFLICT", "errors.review.nothingToDecide")]
        : undefined,
    );
    await open(second.api);
    await click(
      within(within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" })).getByRole("button", {
        name: "Схвалити",
      }),
    );
    expect(screen.getByText(/Рішення вже збігається зі станом відгуку/)).toBeDefined();
  });

  it("409: после перечитывания карточка выпала, а сообщение осталось на экране", async () => {
    let posted = false;
    const { api } = fakeApi((m, p) => {
      if (m === "POST") {
        posted = true;
        return [409, envelope("CONFLICT", "errors.review.invalidDecision")];
      }
      if (posted && p === "/admin/reviews") return [200, { items: [] }];
      return undefined;
    });
    await open(api);
    await click(
      within(within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" })).getByRole("button", {
        name: "Схвалити",
      }),
    );
    expect(screen.queryByRole("article", { name: /Кафе Говерла/ })).toBeNull();
    expect(screen.getByText("Відгуків немає.")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toMatch(/Стан відгуку вже змінився/);
  });

  it("404 тоже перечитывает список и объясняет", async () => {
    const { api, calls } = fakeApi((m) =>
      m === "POST" ? [404, envelope("NOT_FOUND", "errors.notFound")] : undefined,
    );
    await open(api);
    const before = calls.filter((c) => c.path === "/admin/reviews").length;
    await click(
      within(within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" })).getByRole("button", {
        name: "Схвалити",
      }),
    );
    expect(calls.filter((c) => c.path === "/admin/reviews").length).toBe(before + 1);
    expect(screen.getByRole("alert").textContent).toMatch(/модуль відгуків вимкнено/);
  });

  it("повторный клик не шлёт второй запрос, пока решение и перечитывание не закончились", async () => {
    const { api, calls } = fakeApi((m) => (m === "POST" ? [200, REVIEW] : undefined));
    await open(api);
    const button = within(within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" })).getByRole(
      "button",
      { name: "Схвалити" },
    );
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    await flush();
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("ownOrganization — формы решения нет, только пояснение", async () => {
    const { api } = fakeApi(() => undefined, [{ ...REVIEW, ownOrganization: true }]);
    await open(api);
    const a = within(card(/Кафе Говерла/));
    expect(a.queryByRole("form")).toBeNull();
    expect(a.getByText(/пов'язані/)).toBeDefined();
  });
});

describe("відгуки: апеляції", () => {
  it("«Задовольнити апеляцію» — POST appeal-decision grant, предупреждение о финальности", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    const form = within(card(/Готель Карпати/)).getByRole("form", { name: "Рішення за апеляцією" });
    expect(within(form).getByText(/остаточне/)).toBeDefined();
    fireEvent.change(within(form).getByLabelText(/^Пояснення/), { target: { value: "Помилкове рішення" } });
    await click(within(form).getByRole("button", { name: "Задовольнити апеляцію" }));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/admin/reviews/${APPEALED.id}/appeal-decision`);
    expect(post?.body).toEqual({ decision: "grant", reason: "Помилкове рішення" });
    expect(screen.getByText("Апеляцію задоволено: попереднє рішення скасовано.")).toBeDefined();
  });

  it("апеляція партнера: «Задовольнити» без пояснення — ошибка, с пояснением — POST grant", async () => {
    const partner = { ...APPEALED, appeal: { ...APPEAL, kind: "partner" } };
    const { api, calls } = fakeApi(() => undefined, [partner]);
    await open(api);
    const form = within(card(/Готель Карпати/)).getByRole("form", { name: "Рішення за апеляцією" });
    await click(within(form).getByRole("button", { name: "Задовольнити апеляцію" }));
    expect(within(form).getByRole("alert").textContent).toBe("Вкажіть причину — автор її побачить.");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(within(form).getByLabelText(/^Пояснення \(обов/), {
      target: { value: "Відгук неправдивий" },
    });
    await click(within(form).getByRole("button", { name: "Задовольнити апеляцію" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      decision: "grant",
      reason: "Відгук неправдивий",
    });
  });

  it("подпись причины: у скрытого отзыва (только «Повернути») — необязательное пояснение", async () => {
    const { api } = fakeApi(() => undefined, [{ ...REVIEW, status: "hidden" }]);
    await open(api);
    const form = within(card(/Кафе Говерла/)).getByRole("form", { name: "Рішення" });
    expect(within(form).getByLabelText(/^Пояснення \(необов/)).toBeDefined();
  });

  it("«Відхилити апеляцію» без пояснення — тело только decision", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await open(api);
    const form = within(card(/Готель Карпати/)).getByRole("form", { name: "Рішення за апеляцією" });
    await click(within(form).getByRole("button", { name: "Відхилити апеляцію" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ decision: "deny" });
  });

  it("canDecideAppeal=false — кнопок нет, пояснение про іншого модератора; 403 same_moderator на сервере тоже понятен", async () => {
    const { api } = fakeApi(() => undefined, [{ ...APPEALED, canDecideAppeal: false }]);
    await open(api);
    const a = within(card(/Готель Карпати/));
    expect(a.queryByRole("form")).toBeNull();
    expect(a.getByText(/інший модератор/)).toBeDefined();
    cleanup();
    const second = fakeApi((m) =>
      m === "POST"
        ? [403, envelope("FORBIDDEN", "errors.review.appealSameModerator", { reason: "same_moderator" })]
        : undefined,
    );
    await open(second.api);
    await click(
      within(within(card(/Готель Карпати/)).getByRole("form", { name: "Рішення за апеляцією" })).getByRole(
        "button",
        {
          name: "Відхилити апеляцію",
        },
      ),
    );
    expect(within(card(/Готель Карпати/)).getByText(/інший модератор/)).toBeDefined();
  });

  it("409 appealDecided — «вже розглянуто»", async () => {
    const { api } = fakeApi((m) =>
      m === "POST"
        ? [409, envelope("CONFLICT", "errors.review.appealDecided", { reason: "appeal_decided" })]
        : undefined,
    );
    await open(api);
    await click(
      within(within(card(/Готель Карпати/)).getByRole("form", { name: "Рішення за апеляцією" })).getByRole(
        "button",
        {
          name: "Задовольнити апеляцію",
        },
      ),
    );
    expect(screen.getByText(/апеляцію вже розглянуто/)).toBeDefined();
  });
});

describe("навігація", () => {
  it("раздел «Відгуки» есть в меню", async () => {
    const { api } = fakeApi(() => undefined);
    await open(api);
    expect(screen.getByRole("link", { name: "Відгуки" }).getAttribute("href")).toBe("#/reviews");
  });
});
