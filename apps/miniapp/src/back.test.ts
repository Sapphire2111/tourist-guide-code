// Unit: учёт записей истории и «Назад»: есть куда вернуться — history.back(), нет — логичный родитель заменой;
// двойное нажатие — один шаг; ссылка на предыдущий экран — шаг назад; прокрутка и состояние — за записью.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentEntryKey,
  goBack,
  initNavigation,
  normalizeHash,
  parentOf,
  pressBack,
  readSlot,
  resetNavigation,
  writeSlot,
} from "./back.js";
import { interceptBack } from "./telegram.js";

/** Переход, как у hash-роутера: новая запись и событие сразу (jsdom шлёт hashchange асинхронно). */
function push(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Шаг по истории и ожидание смены адреса (jsdom выполняет его асинхронно). */
async function waitPop(act: () => void) {
  const before = window.location.hash;
  act();
  await vi.waitFor(() => expect(window.location.hash).not.toBe(before));
}

beforeEach(() => {
  window.history.replaceState(null, "", "#/");
  resetNavigation();
});

afterEach(() => {
  window.history.replaceState(null, "", "#/");
});

describe("parentOf", () => {
  it.each([
    ["/place/x", "/"],
    ["/section/eat", "/"],
    ["/book/x", "/place/x"],
    ["/plan/scenario/x", "/plan"],
    ["/plan/new", "/plan"],
    ["/plan/saved", "/plan"],
    ["/plan/saved/x", "/plan/saved"],
    ["/plan", "/"],
    ["/partner/place/x/offers", "/partner"],
    ["/partner", "/"],
    ["/", "/"],
  ])("%s → %s", (path, parent) => {
    expect(parentOf(path)).toBe(parent);
  });

  it("цепочка родителей всегда доходит до главной", () => {
    for (let path of ["/book/x", "/plan/saved/x", "/partner/org/x/staff", "/whatever/x"]) {
      for (let i = 0; path !== "/" && i < 5; i++) path = parentOf(path);
      expect(path).toBe("/");
    }
  });
});

describe("normalizeHash", () => {
  it("служебный адрес Telegram и пустой — главная", () => {
    expect(normalizeHash("#tgWebAppData=x")).toBe("#/");
    expect(normalizeHash("")).toBe("#/");
    expect(normalizeHash("#/place/x?a=1")).toBe("#/place/x?a=1");
  });
});

describe("goBack", () => {
  it("вход по прямой ссылке: истории нет — родитель заменой, history.back не вызывается", () => {
    window.history.replaceState(null, "", "#/plan/saved/x");
    resetNavigation();
    initNavigation();
    const back = vi.spyOn(window.history, "back");
    const navigate = vi.fn();
    goBack(navigate);
    expect(back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/plan/saved", { replace: true });
  });

  it("есть запись внутри приложения — history.back(); повторное нажатие до возврата игнорируется", () => {
    initNavigation();
    push("#/section/eat");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const navigate = vi.fn();
    let t = 1000;
    goBack(navigate, () => t);
    goBack(navigate, () => t + 200);
    expect(back).toHaveBeenCalledTimes(1);
    t += 5000;
    goBack(navigate, () => t);
    expect(back).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("настоящая цепочка: A → B → C, назад, назад, затем родитель; записи от replace не копятся", async () => {
    initNavigation();
    push("#/section/eat");
    push("#/place/x");
    // Замена не добавляет записи: один шаг назад — сразу к разделу.
    window.history.replaceState(window.history.state, "", "#/place/y");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const navigate = vi.fn();
    await waitPop(() => goBack(navigate));
    expect(window.location.hash).toBe("#/section/eat");
    await waitPop(() => goBack(navigate, () => Date.now() + 5000));
    expect(window.location.hash).toBe("#/");
    expect(navigate).not.toHaveBeenCalled();
    goBack(navigate, () => Date.now() + 5000);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("после возврата новый переход заменяет «хвост» и номер записи верный", async () => {
    initNavigation();
    push("#/a");
    push("#/b");
    await waitPop(() => window.history.back());
    push("#/c");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    goBack(vi.fn());
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("pressBack", () => {
  it("открыт слой — закрывается он, перехода нет; затем обычный «Назад»", () => {
    window.history.replaceState(null, "", "#/place/x");
    resetNavigation();
    const close = vi.fn();
    const release = interceptBack(close);
    const navigate = vi.fn();
    pressBack(navigate);
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    release();
    pressBack(navigate);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });
});

describe("ссылки приложения", () => {
  function clickLink(href: string): boolean {
    const a = document.createElement("a");
    a.href = href;
    document.body.append(a);
    // Итог обработчика приложения; сам переход отменяем: jsdom выполнил бы его уже в следующем тесте.
    let notPrevented = true;
    const after = (e: Event) => {
      notPrevented = !e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", after);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.removeEventListener("click", after);
    a.remove();
    return notPrevented;
  }

  it("тап по текущему адресу не добавляет запись (и «#/» при служебном адресе Telegram)", () => {
    window.history.replaceState(null, "", "#tgWebAppData=x");
    resetNavigation();
    initNavigation();
    expect(clickLink("#/")).toBe(false);
    push("#/plan");
    expect(clickLink("#/plan")).toBe(false);
  });

  it("ссылка на предыдущий экран — шаг назад, а не A→B→A→B", () => {
    initNavigation();
    push("#/plan");
    push("#/plan/scenario/x");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    expect(clickLink("#/plan")).toBe(false);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("другая ссылка и клик с модификатором — обычный переход", () => {
    initNavigation();
    push("#/plan");
    const back = vi.spyOn(window.history, "back");
    expect(clickLink("#/help")).toBe(true);
    expect(back).not.toHaveBeenCalled();
  });
});

describe("состояние за записью истории", () => {
  it("значение видно только в своей записи и возвращается при шаге назад", async () => {
    initNavigation();
    push("#/section/eat");
    const key = currentEntryKey();
    writeSlot(key, "q", "кава");
    push("#/place/x");
    expect(currentEntryKey()).not.toBe(key);
    expect(readSlot(currentEntryKey(), "q")).toBeUndefined();
    await waitPop(() => window.history.back());
    expect(currentEntryKey()).toBe(key);
    expect(readSlot(key, "q")).toBe("кава");
  });

  it("новый заход на тот же адрес — новая запись и чистое состояние", async () => {
    initNavigation();
    push("#/section/eat");
    const key = currentEntryKey();
    writeSlot(key, "q", "кава");
    await waitPop(() => window.history.back());
    push("#/section/eat");
    expect(currentEntryKey()).not.toBe(key);
    expect(readSlot(currentEntryKey(), "q")).toBeUndefined();
  });

  it("перезагрузка страницы посреди истории: запись и значение из sessionStorage", async () => {
    initNavigation();
    push("#/section/eat");
    const key = currentEntryKey();
    writeSlot(key, "q", "кава");
    window.dispatchEvent(new Event("pagehide"));
    const state: unknown = window.history.state;
    const stored = sessionStorage.getItem("tg.nav.v1");
    resetNavigation();
    sessionStorage.setItem("tg.nav.v1", stored!);
    window.history.replaceState(state, "", "#/section/eat");
    expect(currentEntryKey()).toBe(key);
    expect(readSlot(key, "q")).toBe("кава");
  });

  it("значения «только в памяти» не попадают в sessionStorage", () => {
    initNavigation();
    const key = currentEntryKey();
    writeSlot(key, "geo", { lat: 1 }, true);
    window.dispatchEvent(new Event("pagehide"));
    expect(readSlot(key, "geo", true)).toEqual({ lat: 1 });
    expect(sessionStorage.getItem("tg.nav.v1")).not.toContain("lat");
  });
});

describe("прокрутка", () => {
  let scrollY = 0;
  beforeEach(() => {
    scrollY = 0;
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
    vi.spyOn(window, "scrollTo").mockImplementation(((o: ScrollToOptions) => {
      scrollY = o.top ?? 0;
    }) as typeof window.scrollTo);
  });

  it("новый экран — сверху; возврат — прежняя позиция", async () => {
    initNavigation();
    push("#/section/eat");
    scrollY = 640;
    window.dispatchEvent(new Event("scroll"));
    push("#/place/x");
    expect(scrollY).toBe(0);
    await waitPop(() => window.history.back());
    await vi.waitFor(() => expect(scrollY).toBe(640));
  });

  it("замена на другой экран — сверху; снятие параметра того же экрана — на месте", () => {
    initNavigation();
    push("#/assistant?q=x");
    scrollY = 300;
    window.history.replaceState(window.history.state, "", "#/assistant");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(scrollY).toBe(300);
    window.history.replaceState(window.history.state, "", "#/plan");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(scrollY).toBe(0);
  });
});
