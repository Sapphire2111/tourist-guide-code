import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { createApiClient } from "@tg/api-client";
import { App } from "./App.js";
import { CONSENT_VERSIONS } from "./consents.js";
import {
  ANONYMOUS_ID_KEY,
  clientPlatform,
  createStartup,
  getStartParam,
  getToken,
  setToken,
  TOKEN_KEY,
  type Me,
  type QrContext,
} from "./session.js";
import type { TelegramWebApp } from "./telegram.js";

const ANON = "11111111-2222-4333-8444-555555555555";
const REGION = {
  id: "00000000-0000-4000-8000-000000000001",
  code: "test-region",
  name: { uk: "Тестовий регіон" },
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
};

const hotelContext: QrContext = {
  status: "ok",
  entryType: "hotel",
  region: REGION,
  qrPoint: { id: "00000000-0000-4000-8000-000000000002", type: "hotel", placeId: null, campaign: null },
  venue: {
    name: { uk: "Тестовий готель", en: "Test hotel" },
    description: { uk: "Затишний готель" },
    address: { uk: "вул. Тестова, 1" },
    phone: "+380501234567",
    website: "https://hotel.example",
    telegram: "test_hotel",
  },
  entryContextId: null,
  anonymousId: ANON,
};

function meWith(accepted: boolean, extra: Partial<Me> = {}): Me {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    status: "active",
    language: "uk",
    displayName: null,
    telegram: null,
    consents: accepted
      ? (["terms", "privacy"] as const).map((kind) => ({
          kind,
          version: CONSENT_VERSIONS[kind],
          status: "accepted" as const,
          grantedAt: "2026-11-01T00:00:00Z",
          withdrawnAt: null,
        }))
      : [],
    messagingConsents: [],
    privacyRequests: [],
    staffMode: false,
    ...extra,
  };
}

type Handler = (req: Request) => Response | Promise<Response>;
function fakeApi(routes: Record<string, Handler>) {
  const calls: Request[] = [];
  const fetch = vi.fn(async (req: Request) => {
    calls.push(req.clone());
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const handler =
      routes[key] ??
      Object.entries(routes).find(([k]) => key.startsWith(k.replace(/\*$/, "")) && k.endsWith("*"))?.[1];
    if (url.pathname === "/feature-flags")
      return routes["GET /feature-flags"]?.(req) ?? Response.json({ regionId: null, items: [] });
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    return handler ? handler(req) : Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  });
  return { api: createApiClient({ baseUrl: "http://api.test", fetch }), calls };
}

const login =
  (startParam: string | null = "demoHotel01") =>
  () =>
    Response.json(
      {
        token: "tok-1",
        session: {
          id: "s",
          userId: "u",
          channel: "telegram",
          expiresAt: "2026-12-01T00:00:00Z",
          activeRegionId: null,
          grants: [],
        },
        isNewUser: true,
        startParam,
      },
      { status: 201 },
    );

function webApp(extra: Partial<TelegramWebApp> = {}): TelegramWebApp {
  return {
    initData: "query_id=x&start_param=demoHotel01&hash=y",
    platform: "android",
    initDataUnsafe: { start_param: "demoHotel01" },
    ready: vi.fn(),
    expand: vi.fn(),
    ...extra,
  };
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

beforeEach(() => {
  setToken(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("поток старта", () => {
  it("вход → токен → контекст один раз (повторный вызов и StrictMode) → /me с Bearer; anonymousId сохранён", async () => {
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true)),
    });
    const startup = createStartup(api, webApp());
    render(
      <StrictMode>
        <App api={api} role="guest" webApp={webApp()} startup={startup} />
      </StrictMode>,
    );
    await startup();
    await flush();
    const paths = calls.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths.filter((p) => p === "POST /auth/telegram")).toHaveLength(1);
    expect(paths.filter((p) => p.startsWith("GET /context/"))).toEqual(["GET /context/demoHotel01"]);
    const auth = calls.find((r) => r.url.endsWith("/auth/telegram"))!;
    expect(await auth.json()).toEqual({ initData: webApp().initData, platform: "android" });
    const ctx = calls.find((r) => r.url.includes("/context/"))!;
    expect(ctx.headers.get("Authorization")).toBe("Bearer tok-1");
    expect(calls.find((r) => new URL(r.url).pathname === "/me")!.headers.get("Authorization")).toBe(
      "Bearer tok-1",
    );
    expect(getToken()).toBe("tok-1");
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe("tok-1");
    expect(window.localStorage.getItem(ANONYMOUS_ID_KEY)).toBe(ANON);
    // Заведение из QR — без ручного выбора; карточка «Про заклад» — по кнопке раздела.
    expect(screen.getByTestId("venue-summary").textContent).toBe("Ви відкрили гід: Тестовий готель");
    await act(async () => {
      window.location.hash = "#/about";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("venue-name").textContent).toBe("Тестовий готель");
    expect(screen.getByRole("link", { name: "+380501234567" }).getAttribute("href")).toBe(
      "tel:+380501234567",
    );
    expect(screen.getByRole("link", { name: "@test_hotel" }).getAttribute("href")).toBe(
      "https://t.me/test_hotel",
    );
  });

  it("сохранённый anonymousId передаётся в /context", async () => {
    window.localStorage.setItem(ANONYMOUS_ID_KEY, ANON);
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true)),
    });
    await createStartup(api, webApp())();
    expect(new URL(calls.find((r) => r.url.includes("/context/"))!.url).searchParams.get("anonymousId")).toBe(
      ANON,
    );
  });

  it("без start_param — GET /context (регион по умолчанию), скан QR не запрашивается", async () => {
    const defaultContext: QrContext = {
      ...hotelContext,
      status: "default",
      entryType: "default",
      qrPoint: null,
      venue: null,
    };
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(null),
      "GET /context": () => Response.json(defaultContext),
      "GET /me": () => Response.json(meWith(true)),
    });
    const app = webApp({ initData: "query_id=x&hash=y", initDataUnsafe: {} });
    const startup = createStartup(api, app);
    render(<App api={api} role="guest" webApp={app} startup={startup} />);
    const state = await startup();
    expect(state).toMatchObject({ status: "ready", context: { region: { id: REGION.id } } });
    expect(state).not.toHaveProperty("contextFailed");
    const paths = calls.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/context"));
    expect(paths).toEqual(["/context"]);
    expect((await screen.findByTestId("neutral-context")).textContent).toBe("Ви на Прикарпатті.");
  });

  it("start_param inv_<токен> — приглашение (P14): контекст по умолчанию, токен в состоянии старта", async () => {
    const token = "B".repeat(43);
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(`inv_${token}`),
      "GET /context": () =>
        Response.json({
          ...hotelContext,
          status: "default",
          entryType: "default",
          qrPoint: null,
          venue: null,
        }),
      "GET /me": () => Response.json(meWith(true)),
    });
    const app = webApp({ initData: `query_id=x&start_param=inv_${token}&hash=y`, initDataUnsafe: {} });
    const state = await createStartup(api, app)();
    expect(state).toMatchObject({ status: "ready", invite: token });
    const paths = calls.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/context"));
    expect(paths).toEqual(["/context"]);
  });

  it("приглашение: сначала согласия (C01), затем P14 /partner/invite без токена в адресе", async () => {
    const token = "C".repeat(43);
    let accepted = false;
    const { api, calls } = fakeApi({
      "GET /feature-flags": () =>
        Response.json({ regionId: null, items: [{ key: "module.partner_cabinet", enabled: true }] }),
      "POST /auth/telegram": login(`inv_${token}`),
      "GET /context": () =>
        Response.json({
          ...hotelContext,
          status: "default",
          entryType: "default",
          qrPoint: null,
          venue: null,
        }),
      "GET /me": () => Response.json(meWith(accepted)),
      "GET /partner/me": () => Response.json({ organizations: [] }),
      [`GET /partner/invites/${token}`]: () =>
        Response.json({
          organizationName: "ТОВ Смерека",
          placeNames: [],
          role: "ORG_STAFF",
          state: "active",
          expiresAt: "2026-11-05T00:00:00Z",
          alreadyMember: false,
        }),
    });
    const app = webApp({ initData: `query_id=x&start_param=inv_${token}&hash=y`, initDataUnsafe: {} });
    const startup = createStartup(api, app);
    render(<App api={api} role="guest" webApp={app} startup={startup} />);
    await startup();
    await flush();
    await flush();
    expect(window.location.hash).toBe("#/partner/invite");
    expect(screen.getByTestId("partner-consents")).toBeDefined();
    expect(screen.queryByTestId("invite-preview")).toBeNull();
    expect(calls.some((r) => new URL(r.url).pathname.startsWith("/partner/invites/"))).toBe(false);
    // Согласия приняты (как после формы C01) — показывается приглашение.
    accepted = true;
    cleanup();
    const startup2 = createStartup(api, app);
    render(<App api={api} role="guest" webApp={app} startup={startup2} />);
    await startup2();
    expect((await screen.findByTestId("invite-preview")).textContent).toContain("ТОВ Смерека");
  });

  it("без start_param сбой /context — «Повторити» снова вызывает GET /context", async () => {
    let attempts = 0;
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(null),
      "GET /context": () => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 })
          : Response.json({
              ...hotelContext,
              status: "default",
              entryType: "default",
              qrPoint: null,
              venue: null,
            });
      },
      "GET /me": () => Response.json(meWith(true)),
    });
    const app = webApp({ initData: "query_id=x&hash=y", initDataUnsafe: {} });
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    expect(await screen.findByTestId("context-unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Повторити" }));
    expect((await screen.findByTestId("neutral-context")).textContent).toBe("Ви на Прикарпатті.");
    expect(calls.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/context"))).toEqual([
      "/context",
      "/context",
    ]);
  });

  it("401 на входе — экран ошибки, контекст не запрашивается", async () => {
    const { api, calls } = fakeApi({
      "POST /auth/telegram": () => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    });
    const startup = createStartup(api, webApp());
    render(<App api={api} role="guest" webApp={webApp()} startup={startup} />);
    expect((await screen.findByTestId("start-error")).textContent).toBe(
      "Не вдалося підтвердити вхід через Telegram. Відкрийте застосунок ще раз.",
    );
    expect(calls.some((r) => r.url.includes("/context/"))).toBe(false);
    expect(getToken()).toBeNull();
  });

  it("401 на /me (сессия отклонена) — экран ошибки", async () => {
    const { api } = fakeApi({
      "POST /auth/telegram": login(null),
      "GET /me": () => Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    });
    expect(await createStartup(api, webApp({ initDataUnsafe: {} }))()).toEqual({
      status: "error",
      messageKey: "errors.auth.invalidInitData",
    });
  });

  it("403 — пользователь заблокирован; сеть упала — общая ошибка", async () => {
    const blocked = fakeApi({ "POST /auth/telegram": () => Response.json({}, { status: 403 }) });
    expect(await createStartup(blocked.api, webApp())()).toMatchObject({
      messageKey: "errors.auth.userBlocked",
    });
    const fetch = vi.fn(async () => {
      throw new TypeError("network");
    });
    const down = createApiClient({ baseUrl: "http://api.test", fetch });
    expect(await createStartup(down, webApp())()).toMatchObject({ messageKey: "miniapp.start.error" });
  });

  it("без initData (браузер) — режим без входа, запросов нет", async () => {
    const { api, calls } = fakeApi({});
    expect(await createStartup(api, undefined)()).toEqual({ status: "browser" });
    expect(calls).toHaveLength(0);
  });

  it("неактивная точка — нейтральный экран региона", async () => {
    const { api } = fakeApi({
      "POST /auth/telegram": login("demoHotelOff1"),
      "GET /context/*": () =>
        Response.json({
          ...hotelContext,
          status: "inactive",
          entryType: "default",
          qrPoint: null,
          venue: null,
        }),
      "GET /me": () => Response.json(meWith(true)),
    });
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    expect((await screen.findByTestId("neutral-context")).textContent).toBe("Ви на Прикарпатті.");
    expect(screen.queryByTestId("venue")).toBeNull();
  });

  it("регион без записи падежа — запасная строка «Ви в регіоні: …»; QR заведения — без строки региона", async () => {
    const { api } = fakeApi({
      "POST /auth/telegram": login("demoHotelOff1"),
      "GET /context/*": () =>
        Response.json({
          ...hotelContext,
          status: "default",
          entryType: "default",
          qrPoint: null,
          venue: null,
          region: { ...REGION, code: "other", name: { uk: "Інший край" } },
        }),
      "GET /me": () => Response.json(meWith(true)),
    });
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    expect((await screen.findByTestId("neutral-context")).textContent).toBe("Ви в регіоні: Інший край");
    cleanup();
  });
});

describe("C01 онбординг", () => {
  it("terms+privacy → POST /me/consents; requestWriteAccess → messaging-consent service и marketing", async () => {
    let accepted = false;
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(accepted)),
      "POST /me/consents": () => {
        accepted = true;
        return Response.json({});
      },
      "POST /me/messaging-consent": () => Response.json([]),
    });
    const requestWriteAccess = vi.fn((cb?: (granted: boolean) => void) => cb?.(true));
    const app = webApp({ requestWriteAccess });
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    const button = await screen.findByRole("button", { name: "Продовжити" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Погоджуюся з умовами користування"));
    fireEvent.click(screen.getByLabelText("Погоджуюся з політикою конфіденційності"));
    fireEvent.click(screen.getByLabelText(/Отримувати новини/));
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "Меню" }));
    expect(
      within(await screen.findByRole("dialog", { name: "Меню" })).getByRole("link", { name: "Профіль" }),
    ).toBeDefined();
    const bodies = async (path: string) =>
      Promise.all(calls.filter((r) => new URL(r.url).pathname === path).map((r) => r.json()));
    expect(await bodies("/me/consents")).toEqual([
      { kind: "terms", version: CONSENT_VERSIONS.terms, action: "accept" },
      { kind: "privacy", version: CONSENT_VERSIONS.privacy, action: "accept" },
    ]);
    expect(requestWriteAccess).toHaveBeenCalledOnce();
    expect(await bodies("/me/messaging-consent")).toEqual([
      { purpose: "service", granted: true, source: "request_write_access" },
      { purpose: "marketing", granted: true, source: "request_write_access" },
    ]);
  });
});

describe("C15 профиль", () => {
  it("смена языка — PATCH /me и интерфейс на новом языке", async () => {
    let language = "uk";
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true, { language })),
      "PATCH /me": async (req) => {
        language = ((await req.json()) as { language: string }).language;
        return Response.json(meWith(true, { language }));
      },
      "POST /me/privacy-requests": () =>
        Response.json(
          { id: "x", kind: "export", status: "received", createdAt: "2026-11-02T00:00:00Z" },
          { status: 201 },
        ),
    });
    window.location.hash = "#/profile";
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    const select = await screen.findByLabelText("Мова");
    fireEvent.change(select, { target: { value: "en" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeDefined();
    const patch = calls.find((r) => r.method === "PATCH")!;
    expect(await patch.json()).toEqual({ language: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Request data export" }));
    await flush();
    expect(calls.some((r) => r.url.endsWith("/me/privacy-requests"))).toBe(true);
  });
});

describe("профиль: карточка «Мій заклад»", () => {
  const PLACE_ID = "00000000-0000-4000-8000-00000000b001";
  const orgs = (organizations: unknown[]) => ({ organizations });
  const org = {
    id: "00000000-0000-4000-8000-00000000a001",
    regionId: REGION.id,
    name: "ТОВ Смерека",
    role: "ORG_OWNER",
    assignmentId: "as1",
    abilities: {},
    places: [
      {
        id: PLACE_ID,
        name: { uk: "Садиба Смерека" },
        status: "draft",
        templateCode: "hotel",
        modules: [],
        moderation: null,
        openServiceRequests: 0,
        activeOffers: 0,
      },
    ],
  };
  const open = async (cabinet: boolean, me: unknown) => {
    const { api } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true)),
      "GET /feature-flags": () =>
        Response.json({ regionId: null, items: [{ key: "module.partner_cabinet", enabled: cabinet }] }),
      "GET /partner/me": () => Response.json(me),
    });
    window.location.hash = "#/profile";
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    await screen.findByLabelText("Мова");
    await flush();
  };

  it("партнёр: название заведения, статус и ссылка в кабинет", async () => {
    await open(true, orgs([org]));
    const entry = await screen.findByTestId("partner-entry");
    expect(within(entry).getByText("Садиба Смерека")).toBeDefined();
    expect(within(entry).getByTestId("partner-entry-status").textContent).toBe("Не опубліковано");
    expect(within(entry).getByRole("link", { name: "Мій заклад" }).getAttribute("href")).toBe("#/partner");
  });

  it("не партнёр: нейтральный заголовок и «Стати партнером»", async () => {
    await open(true, orgs([]));
    const entry = await screen.findByTestId("partner-entry");
    expect(within(entry).getByRole("heading", { name: "Для бізнесу" })).toBeDefined();
    expect(within(entry).getByRole("link", { name: "Стати партнером" }).getAttribute("href")).toBe(
      "#/partner/new",
    );
  });

  it("модуль кабинета выключен — карточки нет", async () => {
    await open(false, orgs([org]));
    await flush();
    expect(screen.queryByTestId("partner-entry")).toBeNull();
  });
});

describe("утилиты", () => {
  it("start_param: initDataUnsafe, затем tgWebAppStartParam в query и hash", () => {
    expect(getStartParam(webApp(), { search: "", hash: "" })).toBe("demoHotel01");
    expect(getStartParam(undefined, { search: "?tgWebAppStartParam=abcdefghij", hash: "" })).toBe(
      "abcdefghij",
    );
    expect(
      getStartParam(undefined, { search: "", hash: "#tgWebAppData=x&tgWebAppStartParam=qqqqqqqqqq" }),
    ).toBe("qqqqqqqqqq");
    expect(getStartParam(undefined, { search: "", hash: "#/profile" })).toBeUndefined();
  });

  it("платформа Telegram → ClientPlatform", () => {
    expect(clientPlatform("ios")).toBe("ios");
    expect(clientPlatform("tdesktop")).toBe("desktop");
    expect(clientPlatform("weba")).toBe("web");
    expect(clientPlatform("unknown")).toBe("unknown");
    expect(clientPlatform(undefined)).toBe("unknown");
    expect(clientPlatform("tizen")).toBe("unknown");
    expect(clientPlatform("android_x")).toBe("android");
  });
});

describe("находки ревью", () => {
  it("сбой /context — не нейтральный регион, а «повторити»: один запрос на нажатие", async () => {
    let attempts = 0;
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => {
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 })
          : Response.json(hotelContext);
      },
      "GET /me": () => Response.json(meWith(true)),
    });
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    expect(await screen.findByTestId("context-unavailable")).toBeDefined();
    expect(screen.queryByText("Регіонів ще не додано.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторити" }));
    expect((await screen.findByTestId("venue-summary")).textContent).toBe("Ви відкрили гід: Тестовий готель");
    expect(calls.filter((r) => r.url.includes("/context/"))).toHaveLength(2);
  });

  it("онбординг: ошибка messaging-consent service — marketing не шлётся, ошибка видна", async () => {
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(false)),
      "POST /me/consents": () => Response.json({}),
      "POST /me/messaging-consent": () => Response.json({}, { status: 500 }),
    });
    const app = webApp({ requestWriteAccess: (cb) => cb?.(true) });
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    fireEvent.click(await screen.findByLabelText("Погоджуюся з умовами користування"));
    fireEvent.click(screen.getByLabelText("Погоджуюся з політикою конфіденційності"));
    fireEvent.click(screen.getByLabelText(/Отримувати новини/));
    fireEvent.click(screen.getByRole("button", { name: "Продовжити" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Не вдалося зберегти згоду. Спробуйте ще раз.",
    );
    expect(calls.filter((r) => r.url.endsWith("/me/messaging-consent"))).toHaveLength(1);
  });

  it("онбординг: requestWriteAccess отклонён при отмеченном маркетинге — сообщение, marketing не шлётся", async () => {
    let accepted = false;
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(accepted)),
      "POST /me/consents": () => {
        accepted = true;
        return Response.json({});
      },
      "POST /me/messaging-consent": () => Response.json([]),
    });
    const app = webApp({ requestWriteAccess: (cb) => cb?.(false) });
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    fireEvent.click(await screen.findByLabelText("Погоджуюся з умовами користування"));
    fireEvent.click(screen.getByLabelText("Погоджуюся з політикою конфіденційності"));
    fireEvent.click(screen.getByLabelText(/Отримувати новини/));
    fireEvent.click(screen.getByRole("button", { name: "Продовжити" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Без дозволу боту писати");
    const bodies = await Promise.all(
      calls.filter((r) => r.url.endsWith("/me/messaging-consent")).map((r) => r.json()),
    );
    expect(bodies).toEqual([{ purpose: "service", granted: false, source: "request_write_access" }]);
    fireEvent.click(screen.getByRole("button", { name: "Продовжити" }));
    fireEvent.click(await screen.findByRole("button", { name: "Меню" }));
    expect(
      within(await screen.findByRole("dialog", { name: "Меню" })).getByRole("link", { name: "Профіль" }),
    ).toBeDefined();
  });

  it("профиль: включение сервисных без разрешения Telegram — не включается; удаление — с подтверждением", async () => {
    let requests: Me["privacyRequests"] = [];
    const { api, calls } = fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true, { privacyRequests: requests })),
      "POST /me/privacy-requests": () => {
        requests = [{ id: "r1", kind: "delete", status: "received", createdAt: "2026-11-02T00:00:00Z" }];
        return Response.json(requests[0], { status: 201 });
      },
    });
    const app = webApp({ requestWriteAccess: (cb) => cb?.(false) });
    window.location.hash = "#/profile";
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    fireEvent.click(await screen.findByLabelText("Сервісні повідомлення"));
    expect((await screen.findByRole("alert")).textContent).toContain("Telegram не надав дозвіл");
    expect(calls.some((r) => r.url.endsWith("/me/messaging-consent"))).toBe(false);
    expect((screen.getByLabelText("Сервісні повідомлення") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Запросити видалення даних" }));
    expect(calls.some((r) => r.url.endsWith("/me/privacy-requests"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Так, видалити мої дані" }));
    expect((await screen.findByTestId("privacy-requests")).textContent).toBe("Запит на видалення: отримано");
    expect(
      (screen.getByRole("button", { name: "Запросити видалення даних" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("профиль: повторные нажатия", () => {
  const profileApi = () =>
    fakeApi({
      "POST /auth/telegram": login(),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /me": () => Response.json(meWith(true)),
      "POST /me/messaging-consent": () => Response.json([]),
    });

  it("пока идёт requestWriteAccess — переключатели неактивны, второго запроса нет", async () => {
    const { api } = profileApi();
    let answer: ((granted: boolean) => void) | undefined;
    const requestWriteAccess = vi.fn((cb?: (granted: boolean) => void) => {
      answer = cb;
    });
    const app = webApp({ requestWriteAccess });
    window.location.hash = "#/profile";
    render(<App api={api} role="guest" webApp={app} startup={createStartup(api, app)} />);
    const service = (await screen.findByLabelText("Сервісні повідомлення")) as HTMLInputElement;
    fireEvent.click(service);
    await flush();
    expect(service.disabled).toBe(true);
    fireEvent.click(service);
    expect(requestWriteAccess).toHaveBeenCalledOnce();
    await act(async () => answer?.(true));
    await flush();
    expect(service.disabled).toBe(false);
    expect(screen.queryByText(/Telegram не надав дозвіл/)).toBeNull();
  });

  it("удаление: подтверждение — отдельная кнопка, фокус на «Скасувати», исходная неактивна", async () => {
    const { api, calls } = profileApi();
    window.location.hash = "#/profile";
    render(<App api={api} role="guest" startup={createStartup(api, webApp())} />);
    const del = (await screen.findByRole("button", {
      name: "Запросити видалення даних",
    })) as HTMLButtonElement;
    fireEvent.click(del);
    fireEvent.click(del); // двойное нажатие на исходной кнопке
    expect(del.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Скасувати" }));
    expect(calls.some((r) => r.url.endsWith("/me/privacy-requests"))).toBe(false);
  });
});

describe("скан QR из приложения", () => {
  const defaultContext: QrContext = {
    ...hotelContext,
    status: "default",
    entryType: "default",
    qrPoint: null,
    venue: null,
  };
  function scanApp(version = true) {
    const handlers = new Map<string, (p?: { data?: string }) => void>();
    const app = webApp({
      initData: "query_id=x&hash=y",
      initDataUnsafe: {},
      isVersionAtLeast: () => version,
      onEvent: (e, cb) => void handlers.set(e, cb),
      offEvent: (e) => void handlers.delete(e),
      showScanQrPopup: vi.fn(),
      closeScanQrPopup: vi.fn(),
    });
    return { app, handlers };
  }
  async function setup(version = true, partnerCabinet = false) {
    const token = "D".repeat(43);
    const { api, calls } = fakeApi({
      ...(partnerCabinet
        ? {
            "GET /feature-flags": () =>
              Response.json({ regionId: null, items: [{ key: "module.partner_cabinet", enabled: true }] }),
            "GET /partner/me": () => Response.json({ organizations: [] }),
            [`GET /partner/invites/${token}`]: () =>
              Response.json({
                organizationName: "ТОВ Смерека",
                placeNames: [],
                role: "ORG_STAFF",
                state: "active",
                expiresAt: "2026-11-05T00:00:00Z",
                alreadyMember: false,
              }),
          }
        : {}),
      "POST /auth/telegram": login(null),
      "GET /context/*": () => Response.json(hotelContext),
      "GET /context": () => Response.json(defaultContext),
      "GET /me": () => Response.json(meWith(true)),
    });
    const { app, handlers } = scanApp(version);
    const startup = createStartup(api, app);
    render(<App api={api} role="guest" webApp={app} startup={startup} />);
    await startup();
    await flush();
    return { app, handlers, calls };
  }
  const contextPaths = (calls: Request[]) =>
    calls.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/context"));

  it("наша ссылка: GET /context/{код}, заведение применено без перезапуска, переход на «Про заклад»", async () => {
    const { app, handlers, calls } = await setup();
    fireEvent.click(screen.getByTestId("scan-btn"));
    expect(app.showScanQrPopup).toHaveBeenCalledOnce();
    await act(async () =>
      handlers.get("qrTextReceived")!({ data: "https://t.me/tg_gid_bot?startapp=demoHotel01" }),
    );
    await flush();
    expect(contextPaths(calls)).toEqual(["/context", "/context/demoHotel01"]);
    expect(app.closeScanQrPopup).toHaveBeenCalled();
    expect(screen.getByTestId("venue-name").textContent).toBe("Тестовий готель");
  });

  it("чужая ссылка: сообщение, запроса контекста нет", async () => {
    const { handlers, calls } = await setup();
    fireEvent.click(screen.getByTestId("scan-btn"));
    await act(async () =>
      handlers.get("qrTextReceived")!({ data: "https://evil.example/?startapp=demoHotel01" }),
    );
    await flush();
    expect(screen.getByTestId("scan-message").textContent).toBe("Це не QR-код Гіда туриста");
    expect(contextPaths(calls)).toEqual(["/context"]);
  });

  it("приглашение при включённом кабинете партнёра: переход на P14", async () => {
    const { handlers } = await setup(true, true);
    await flush();
    fireEvent.click(screen.getByTestId("scan-btn"));
    await act(async () =>
      handlers.get("qrTextReceived")!({ data: `https://t.me/tg_gid_bot?startapp=inv_${"D".repeat(43)}` }),
    );
    await flush();
    await flush();
    expect(window.location.hash).toBe("#/partner/invite");
  });

  it("приглашение при выключенном кабинете: сообщение, токен не сохранён, перехода нет", async () => {
    const { handlers, calls } = await setup();
    fireEvent.click(screen.getByTestId("scan-btn"));
    await act(async () =>
      handlers.get("qrTextReceived")!({ data: `https://t.me/tg_gid_bot?startapp=inv_${"D".repeat(43)}` }),
    );
    await flush();
    expect(screen.getByTestId("scan-message").textContent).toBe("Це не QR-код Гіда туриста");
    expect(window.location.hash).not.toBe("#/partner/invite");
    expect(calls.some((r) => new URL(r.url).pathname.startsWith("/partner/invites/"))).toBe(false);
  });

  it("пункт в меню запускает сканер; на старом Telegram кнопок нет", async () => {
    const { app } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    fireEvent.click(screen.getByTestId("scan-menu-item"));
    expect(app.showScanQrPopup).toHaveBeenCalledOnce();
    cleanup();
    await setup(false);
    expect(screen.queryByTestId("scan-btn")).toBeNull();
  });
});
