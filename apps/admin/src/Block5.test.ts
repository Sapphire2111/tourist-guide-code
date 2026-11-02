import { describe, expect, it } from "vitest";
import { hostProblem } from "./HostModule.js";
import { staffBody } from "./PlaceStaff.js";

const form = (over: Partial<Parameters<typeof hostProblem>[0]> = {}) => ({
  enabled: true,
  wifiSsid: "",
  wifiPassword: "",
  receptionPhone: "",
  hoursFrom: "",
  hoursTo: "",
  sections: [],
  services: [],
  ...over,
});
const service = (sla: string) => ({
  code: "cleaning",
  title: { uk: "Прибирання", en: "" },
  description: { uk: "", en: "" },
  sla,
  enabled: true,
});

describe("блок 5: проверки форм", () => {
  it("hostProblem: SLA 5–1440 целое, часы парой", () => {
    expect(hostProblem(form({ services: [service("45")] }))).toBeNull();
    expect(hostProblem(form({ services: [service("4")] }))).toBe("admin.host.slaInvalid");
    expect(hostProblem(form({ services: [service("1441")] }))).toBe("admin.host.slaInvalid");
    expect(hostProblem(form({ services: [service("1.5")] }))).toBe("admin.host.slaInvalid");
    expect(hostProblem(form({ hoursFrom: "08:00" }))).toBe("admin.host.hoursPair");
    expect(hostProblem(form({ hoursFrom: "08:00", hoursTo: "22:00" }))).toBeNull();
  });

  it("staffBody: Telegram id числом, username без @, мусор отклоняется", () => {
    expect(staffBody("id", " 123456789 ", "ORG_STAFF")).toEqual({
      telegramUserId: "123456789",
      role: "ORG_STAFF",
    });
    expect(staffBody("id", "abc", "ORG_STAFF")).toBeNull();
    expect(staffBody("username", "@hotel_staff", "ORG_OWNER")).toEqual({
      username: "hotel_staff",
      role: "ORG_OWNER",
    });
    expect(staffBody("username", "ab", "ORG_STAFF")).toBeNull();
  });
});
