import { describe, expect, it } from "vitest";
import { menuRequests } from "./menu.js";

describe("menuRequests", () => {
  it("web_app-кнопка меню и команда start", () => {
    expect(menuRequests("https://m.example/app")).toEqual([
      {
        method: "setChatMenuButton",
        body: {
          menu_button: { type: "web_app", text: "Відкрити гід", web_app: { url: "https://m.example/app" } },
        },
      },
      { method: "setMyCommands", body: { commands: [{ command: "start", description: "Відкрити гід" }] } },
    ]);
  });
  it("без https-адреса — ошибка", () => {
    expect(() => menuRequests(undefined)).toThrow();
    expect(() => menuRequests("http://localhost:5173")).toThrow();
  });
});
