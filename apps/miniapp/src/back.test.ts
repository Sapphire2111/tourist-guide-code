// Unit: «Назад» — по истории только из экрана, открытого из ассистента (метка записи); иначе — на главную заменой
// (вход по QR прямо на #/assistant или replace-переход не выкидывают из Mini App); двойное нажатие — один шаг.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FROM_ASSISTANT, goBack, pushFromAssistant, resetBackGuard } from "./back.js";

afterEach(() => {
  resetBackGuard();
  window.location.hash = "";
});

const fakeHistory = (state: unknown) => ({ state, back: vi.fn(), pushState: vi.fn() });

describe("goBack", () => {
  it("карточка открыта не из ассистента (state без метки) — на главную, история не трогается", () => {
    const navigate = vi.fn();
    const h = fakeHistory(null);
    goBack(navigate, h);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(h.back).not.toHaveBeenCalled();
  });

  it("вход по QR прямо на #/assistant (одна запись, без метки) — «Назад» не выходит из Mini App", () => {
    const navigate = vi.fn();
    const h = fakeHistory({ other: 1 });
    goBack(navigate, h);
    expect(h.back).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("из ассистента — history.back(); повторное нажатие до возврата игнорируется", () => {
    let t = 1000;
    const navigate = vi.fn();
    const h = fakeHistory({ [FROM_ASSISTANT]: true });
    goBack(navigate, h, () => t);
    goBack(navigate, h, () => t + 200);
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    t += 5000;
    goBack(navigate, h, () => t);
    expect(h.back).toHaveBeenCalledTimes(2);
  });

  it("переход из ассистента — pushState с меткой и событие hashchange для роутера", () => {
    const h = fakeHistory(null);
    const onHash = vi.fn();
    window.addEventListener("hashchange", onHash);
    pushFromAssistant("#/place/x", h);
    window.removeEventListener("hashchange", onHash);
    expect(h.pushState).toHaveBeenCalledWith({ [FROM_ASSISTANT]: true }, "", "#/place/x");
    expect(onHash).toHaveBeenCalledTimes(1);
  });
});
