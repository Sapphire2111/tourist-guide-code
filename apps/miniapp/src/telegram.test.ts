import { describe, expect, it, vi } from "vitest";
import { canScanQr, scanQr, type TelegramWebApp } from "./telegram.js";

type Handler = (p?: { data?: string }) => void;
function fake(version = "7.0", over: Partial<TelegramWebApp> = {}) {
  const handlers = new Map<string, Handler>();
  const app: TelegramWebApp = {
    ready: vi.fn(),
    expand: vi.fn(),
    isVersionAtLeast: (v) => Number.parseFloat(version) >= Number.parseFloat(v),
    onEvent: vi.fn((e: string, cb: Handler) => void handlers.set(e, cb)),
    offEvent: vi.fn((e: string) => void handlers.delete(e)),
    showScanQrPopup: vi.fn(),
    closeScanQrPopup: vi.fn(),
    ...over,
  };
  return { app, handlers };
}

describe("сканер QR Telegram", () => {
  it("доступен с 6.4 и при наличии методов", () => {
    expect(canScanQr(fake("6.4").app)).toBe(true);
    expect(canScanQr(fake("6.2").app)).toBe(false);
    expect(canScanQr(fake("7.0", { showScanQrPopup: undefined }).app)).toBe(false);
    expect(canScanQr(undefined)).toBe(false);
  });

  it("qrTextReceived: закрывает окно и возвращает текст, обработчики сняты", async () => {
    const { app, handlers } = fake();
    const p = scanQr(app, "Наведіть");
    expect(app.showScanQrPopup).toHaveBeenCalledWith({ text: "Наведіть" });
    handlers.get("qrTextReceived")!({ data: "https://t.me/b?startapp=x" });
    await expect(p).resolves.toBe("https://t.me/b?startapp=x");
    expect(app.closeScanQrPopup).toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });

  it("закрытие сканера без текста: null", async () => {
    const { app, handlers } = fake();
    const p = scanQr(app, "x");
    handlers.get("scanQrPopupClosed")!();
    await expect(p).resolves.toBeNull();
  });

  it("недоступный сканер или исключение: null", async () => {
    await expect(scanQr(fake("6.0").app, "x")).resolves.toBeNull();
    const boom = fake("7.0", {
      showScanQrPopup: () => {
        throw new Error("x");
      },
    });
    await expect(scanQr(boom.app, "x")).resolves.toBeNull();
  });
});
