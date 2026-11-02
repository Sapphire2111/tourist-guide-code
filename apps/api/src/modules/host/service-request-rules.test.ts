// Unit: правила заявки гостиницы (states-and-rules §2, S-03, D-55) — переходы статусов, отмена гостем, часы приёма
// (в т. ч. через полночь и по таймзоне региона), ближайшее открытие, SLA и просрочка.
import { describe, expect, it } from "vitest";
import { SERVICE_REQUEST_STATUSES, type ServiceRequestStatus } from "../../db/index.js";
import {
  canGuestCancel,
  canStaffMove,
  isOverdue,
  nextOpening,
  slaDueAt,
  staffTransitions,
  withinHours,
  zonedInstant,
} from "./service-request-rules.js";

const KYIV = "Europe/Kyiv";

describe("переходы статусов", () => {
  it("персонал: new → accepted → in_progress → done; new|accepted → rejected", () => {
    const allowed: [ServiceRequestStatus, ServiceRequestStatus][] = [
      ["new", "accepted"],
      ["new", "rejected"],
      ["accepted", "in_progress"],
      ["accepted", "rejected"],
      ["in_progress", "done"],
    ];
    for (const from of SERVICE_REQUEST_STATUSES)
      for (const to of SERVICE_REQUEST_STATUSES)
        expect(canStaffMove(from, to), `${from} → ${to}`).toBe(
          allowed.some(([f, t]) => f === from && t === to),
        );
  });

  it("недопустимо: перепрыгнуть статус, вернуться назад, менять финальные", () => {
    expect(canStaffMove("new", "done")).toBe(false);
    expect(canStaffMove("new", "in_progress")).toBe(false);
    expect(canStaffMove("in_progress", "accepted")).toBe(false);
    expect(canStaffMove("in_progress", "rejected")).toBe(false);
    for (const s of ["done", "rejected", "cancelled_by_guest"] as const)
      expect(staffTransitions(s)).toEqual([]);
    // Отмену от имени гостя персонал не ставит.
    expect(canStaffMove("new", "cancelled_by_guest")).toBe(false);
  });

  it("гость отменяет только new и accepted", () => {
    expect(SERVICE_REQUEST_STATUSES.filter(canGuestCancel)).toEqual(["new", "accepted"]);
  });
});

describe("часы приёма (D-55)", () => {
  it("обычное окно и окно через полночь; null — круглосуточно", () => {
    const day = { from: "08:00", to: "22:00" };
    expect(withinHours(day, 8 * 60)).toBe(true);
    expect(withinHours(day, 21 * 60 + 59)).toBe(true);
    expect(withinHours(day, 22 * 60)).toBe(false);
    expect(withinHours(day, 7 * 60 + 59)).toBe(false);
    const night = { from: "20:00", to: "02:00" };
    expect(withinHours(night, 23 * 60)).toBe(true);
    expect(withinHours(night, 60)).toBe(true);
    expect(withinHours(night, 3 * 60)).toBe(false);
    expect(withinHours(null, 0)).toBe(true);
  });

  it("zonedInstant: местное время Киева → UTC (зима +2, лето +3)", () => {
    expect(zonedInstant("2026-11-02", 8 * 60, KYIV).toISOString()).toBe("2026-11-02T06:00:00.000Z");
    expect(zonedInstant("2026-07-01", 8 * 60, KYIV).toISOString()).toBe("2026-07-01T05:00:00.000Z");
  });

  it("nextOpening: в часы приёма — null; ночью — сегодня в 08:00; поздно вечером — завтра в 08:00", () => {
    const hours = { from: "08:00", to: "22:00" };
    // 12:00 Киева.
    expect(nextOpening(hours, new Date("2026-11-02T10:00:00Z"), KYIV)).toBeNull();
    // 03:00 Киева → 08:00 того же дня.
    expect(nextOpening(hours, new Date("2026-11-02T01:00:00Z"), KYIV)?.toISOString()).toBe(
      "2026-11-02T06:00:00.000Z",
    );
    // 23:30 Киева → 08:00 следующего дня.
    expect(nextOpening(hours, new Date("2026-11-02T21:30:00Z"), KYIV)?.toISOString()).toBe(
      "2026-11-03T06:00:00.000Z",
    );
    expect(nextOpening(null, new Date(), KYIV)).toBeNull();
  });
});

describe("SLA", () => {
  it("срок — от начала обработки + минуты услуги; без SLA — null", () => {
    const start = new Date("2026-11-02T10:00:00Z");
    expect(slaDueAt(start, 30)?.toISOString()).toBe("2026-11-02T10:30:00.000Z");
    expect(slaDueAt(start, null)).toBeNull();
  });

  it("просрочка — только у открытой заявки после срока", () => {
    const due = new Date("2026-11-02T10:30:00Z");
    const after = new Date("2026-11-02T10:31:00Z");
    expect(isOverdue("new", due, after)).toBe(true);
    expect(isOverdue("in_progress", due, after)).toBe(true);
    expect(isOverdue("done", due, after)).toBe(false);
    expect(isOverdue("new", due, new Date("2026-11-02T10:00:00Z"))).toBe(false);
    expect(isOverdue("new", null, after)).toBe(false);
  });
});
