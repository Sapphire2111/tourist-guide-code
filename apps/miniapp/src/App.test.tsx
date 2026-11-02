import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createApiClient } from "@tg/api-client";
import { App } from "./App.js";
import { getStubRole } from "./role.js";
import { getWebApp, initTelegram, type TelegramWebApp } from "./telegram.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  document.documentElement.removeAttribute("style");
});

/**
 * Клиент с подменённым fetch: `/health` отвечает заданным статусом, `/feature-flags` — флагами (по умолчанию
 * кабинет партнёра включён).
 */
function apiWith(
  status: number,
  body: unknown = { status: "ok" },
  flags: Record<string, boolean> = { "module.partner_cabinet": true },
) {
  const fetch = vi.fn(async (req: Request) =>
    new URL(req.url).pathname === "/feature-flags"
      ? Response.json({
          regionId: null,
          items: Object.entries(flags).map(([key, enabled]) => ({ key, enabled })),
        })
      : Response.json(body, { status }),
  );
  return createApiClient({ baseUrl: "http://api.test", fetch });
}

function fakeWebApp(): TelegramWebApp & { BackButton: Record<string, ReturnType<typeof vi.fn>> } {
  return {
    initData: "query_id=x&hash=y",
    platform: "android",
    initDataUnsafe: { user: { id: 1, first_name: "Олена" } },
    themeParams: { bg_color: "#17212b", button_color: "#5288c1" },
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
  };
}

describe("главная", () => {
  it("гость: приветствие, режим, статус api через клиент", async () => {
    const webApp = fakeWebApp();
    render(<App api={apiWith(200)} role="guest" user={webApp.initDataUnsafe?.user} />);
    expect(screen.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeDefined();
    expect(screen.getByTestId("tg-user").textContent).toBe("Вітаємо, Олена!");
    expect(screen.getByTestId("role").textContent).toBe("Режим: гість");
    expect(screen.queryByRole("link", { name: "Кабінет партнера" })).toBeNull();
    expect(await screen.findByText("Сервер працює")).toBeDefined();
  });

  it("api недоступен — статус ошибки", async () => {
    render(<App api={apiWith(503, { code: "SERVICE_UNAVAILABLE" })} role="guest" />);
    expect(await screen.findByText("Сервер недоступний")).toBeDefined();
  });

  it("локаль en: тексты Mini App на en (fallback на uk проверяется в @tg/i18n)", () => {
    render(<App api={apiWith(200)} role="guest" locale="en" />);
    expect(screen.getByRole("heading", { level: 1, name: "Tourist Guide" })).toBeDefined();
    expect(screen.getByTestId("role").textContent).toBe("Mode: guest");
  });
});

describe("роутинг и ролевой режим", () => {
  it("переход между экранами: фокус на h1 нового экрана, BackButton не мигает", async () => {
    const webApp = fakeWebApp();
    render(<App api={apiWith(200)} role="guest" webApp={webApp} />);
    const go = (hash: string) =>
      act(async () => {
        window.location.hash = hash;
        await new Promise((r) => setTimeout(r, 0));
      });
    await go("#/help");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.textContent).toBe("Халепа?");
    expect(webApp.BackButton.show).toHaveBeenCalledTimes(1);
    await go("#/nope");
    expect(document.activeElement?.textContent).toBe("Сторінку не знайдено");
    // Экран не пересоздаётся целиком: кнопка «Назад» Telegram не скрывается между экранами.
    expect(webApp.BackButton.hide).not.toHaveBeenCalled();
    await go("#/");
    expect(document.activeElement?.textContent).toBe("Гід туриста");
    expect(webApp.BackButton.hide).toHaveBeenCalledTimes(1);
  });

  it("партнёр: ссылка в кабинет и экран кабинета", async () => {
    render(<App api={apiWith(200)} role="partner" />);
    expect(screen.getByTestId("role").textContent).toBe("Режим: партнер");
    const link = await screen.findByRole("link", { name: "Кабінет партнера" });
    await act(async () => {
      link.click();
      window.location.hash = "#/partner"; // jsdom не переходит по href сам
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Кабінет партнера" })).toBeDefined();
    // Без сессии Telegram кабинет не открывается (данные — /partner/* с сессией).
    expect(screen.getByText("Кабінет партнера відкривається з Telegram.")).toBeDefined();
  });

  it("партнёр: модуль кабинета выключен флагом — пункта нет", async () => {
    render(<App api={apiWith(200, undefined, { "module.partner_cabinet": false })} role="partner" />);
    expect(await screen.findByText("Сервер працює")).toBeDefined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByRole("link", { name: "Кабінет партнера" })).toBeNull();
  });

  it("партнёр: модуль кабинета выключен флагом — прямой путь /partner ведёт на «не найдено»", async () => {
    window.location.hash = "#/partner";
    render(<App api={apiWith(200, undefined, { "module.partner_cabinet": false })} role="partner" />);
    // Флаги загружены (ответ с выключенным модулем) — экран всё равно «не найдено».
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeDefined();
    expect(screen.queryByText("Кабінет партнера відкривається з Telegram.")).toBeNull();
  });

  it("гость в кабинете партнёра — отказ; «Назад» ведёт на главную без новой записи истории", async () => {
    window.location.hash = "#/partner";
    const historyLength = window.history.length;
    render(<App api={apiWith(200)} role="guest" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Розділ доступний лише партнерам.");
    await act(async () => {
      screen.getByRole("button", { name: "Назад" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeDefined();
    expect(window.location.hash).toBe("#/");
    expect(window.history.length).toBe(historyLength);
  });

  it("неизвестный путь — «не найдено»", () => {
    window.location.hash = "#/nope";
    render(<App api={apiWith(200)} role="guest" />);
    expect(screen.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeDefined();
  });

  it("в Telegram вместо своей кнопки — нативная BackButton; ready() после рендера", async () => {
    window.location.hash = "#/partner";
    const webApp = fakeWebApp();
    const { unmount } = render(<App api={apiWith(200)} role="partner" webApp={webApp} />);
    expect(webApp.ready).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();
    expect(webApp.BackButton.show).toHaveBeenCalled();
    const onBack = vi.mocked(webApp.BackButton.onClick).mock.calls[0]![0] as () => void;
    await act(async () => {
      onBack();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeDefined();
    // экран сменился → кнопка снята с тем же колбэком
    expect(webApp.BackButton.offClick).toHaveBeenCalledWith(onBack);
    expect(webApp.BackButton.hide).toHaveBeenCalled();
    unmount();
  });

  it("роль-заглушка из ?role=", () => {
    expect(getStubRole("?role=partner")).toBe("partner");
    expect(getStubRole("?role=admin")).toBe("guest");
    expect(getStubRole("")).toBe("guest");
  });
});

describe("Telegram WebApp", () => {
  it("вне Telegram (нет WebApp или platform unknown и пустой initData) — undefined", () => {
    expect(getWebApp({})).toBeUndefined();
    expect(
      getWebApp({ Telegram: { WebApp: { platform: "unknown", initData: "", initDataUnsafe: {} } } }),
    ).toBeUndefined();
  });

  it("в Telegram без пользователя — WebApp есть, initTelegram вызывается", () => {
    const webApp = { ...fakeWebApp(), initData: "", platform: "ios", initDataUnsafe: {} };
    expect(getWebApp({ Telegram: { WebApp: webApp } })).toBe(webApp);
    initTelegram(webApp, document.documentElement);
    expect(webApp.expand).toHaveBeenCalledOnce();
  });

  it("initTelegram: тема в CSS-переменные, expand, смена темы обновляет переменные", () => {
    const webApp = fakeWebApp();
    const root = document.documentElement;
    initTelegram(webApp, root);
    expect(root.style.getPropertyValue("--tg-theme-bg-color")).toBe("#17212b");
    expect(root.style.getPropertyValue("--tg-theme-button-color")).toBe("#5288c1");
    expect(webApp.expand).toHaveBeenCalledOnce();
    expect(webApp.ready).not.toHaveBeenCalled(); // ready() — в App после рендера
    const onEvent = webApp.onEvent as ReturnType<typeof vi.fn>;
    expect(onEvent).toHaveBeenCalledWith("themeChanged", expect.any(Function));
    webApp.themeParams = { bg_color: "#ffffff" };
    (onEvent.mock.calls[0]![1] as () => void)();
    expect(root.style.getPropertyValue("--tg-theme-bg-color")).toBe("#ffffff");
  });
});
