import { describe, expect, it } from "vitest";
import {
  availabilityNow,
  customerResponseDue,
  findSlot,
  generateSlots,
  hasOpenRule,
  isFree,
  normalizeCustomerName,
  occupiedRange,
  partnerPermission,
  partnerResponseDue,
  partnerTransitions,
  rulesProblems,
  transitionActor,
  userCancelAllowed,
  userCancelDeadline,
  userTransitions,
  windowsOn,
  type RuleInput,
} from "./booking-rules.js";

const TZ = "Europe/Kyiv";
const MIN = 60_000;
// 2026-11-09 — понедельник; Киев зимой UTC+2.
const MONDAY = "2026-11-09";
const NOW = new Date("2026-11-08T08:00:00Z");
const weekly = (dow: number, opens: number, closes: number): RuleInput => ({
  dayOfWeek: dow,
  date: null,
  closed: false,
  opensMin: opens,
  closesMin: closes,
});
const resource = {
  slot_duration_min: 60,
  buffer_before_min: 0,
  buffer_after_min: 0,
  lead_time_min: 60,
  horizon_days: 30,
};

describe("переходы статусов брони (states-and-rules §3.4)", () => {
  it("турист: отмена до завершения и ответ на альтернативу; партнёр — остальное", () => {
    expect(transitionActor("pending_partner", "cancelled_by_user")).toBe("user");
    expect(transitionActor("alternative_proposed", "confirmed")).toBe("user");
    expect(transitionActor("pending_partner", "confirmed")).toBe("partner");
    expect(transitionActor("pending_partner", "alternative_proposed")).toBe("partner");
    expect(transitionActor("confirmed", "no_show")).toBe("partner");
    expect(transitionActor("no_show", "completed")).toBe("partner");
    expect(userTransitions("completed")).toEqual([]);
  });

  it("C-27: completed → no_show запрещён; из expired/cancelled переходов нет", () => {
    expect(transitionActor("completed", "no_show")).toBeUndefined();
    expect(partnerTransitions("expired")).toEqual([]);
    expect(transitionActor("cancelled_by_user", "confirmed")).toBeUndefined();
    expect(transitionActor("confirmed", "alternative_proposed")).toBeUndefined();
  });

  it("права: подтверждение, альтернатива, отказ, completed, no_show; исправление no_show — менеджер", () => {
    expect(partnerPermission("pending_partner", "confirmed")).toBe("booking.confirm");
    expect(partnerPermission("pending_partner", "alternative_proposed")).toBe("booking.propose_alternative");
    expect(partnerPermission("pending_partner", "cancelled_by_partner")).toBe("booking.reject");
    expect(partnerPermission("confirmed", "completed")).toBe("booking.complete");
    expect(partnerPermission("confirmed", "no_show")).toBe("booking.no_show");
    expect(partnerPermission("no_show", "completed")).toBe("booking.reject");
  });
});

describe("отмена туристом (states-and-rules §3.4)", () => {
  const now = new Date("2026-11-09T08:00:00Z");
  const inMin = (m: number) => new Date(now.getTime() + m * MIN);

  it("confirmed — не позже чем за 2 ч до начала; неподтверждённая — до начала", () => {
    expect(userCancelAllowed("confirmed", inMin(121), now)).toBe(true);
    expect(userCancelAllowed("confirmed", inMin(120), now)).toBe(false);
    expect(userCancelAllowed("pending_partner", inMin(1), now)).toBe(true);
    expect(userCancelAllowed("pending_partner", now, now)).toBe(false);
    expect(userCancelAllowed("alternative_proposed", inMin(-5), now)).toBe(false);
  });
});

describe("слоты (D-04 А, BR-08)", () => {
  it("сетка из недельного окна в таймзоне региона: 10:00–14:00 по Киеву = 08:00–12:00 UTC", () => {
    const slots = generateSlots(resource, [weekly(1, 600, 840)], MONDAY, 1, TZ, NOW);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-09T08:00:00.000Z",
      "2026-11-09T09:00:00.000Z",
      "2026-11-09T10:00:00.000Z",
      "2026-11-09T11:00:00.000Z",
    ]);
    expect(slots[0]!.endsAt.toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });

  it("buffer до/после: шаг = длительность + оба buffer, занятость шире слота", () => {
    const r = { ...resource, buffer_before_min: 15, buffer_after_min: 15 };
    const slots = generateSlots(r, [weekly(1, 600, 840)], MONDAY, 1, TZ, NOW);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-11-09T08:00:00.000Z",
      "2026-11-09T09:30:00.000Z",
      "2026-11-09T11:00:00.000Z",
    ]);
    expect(slots[1]!.occupiedFrom.toISOString()).toBe("2026-11-09T09:15:00.000Z");
    expect(slots[1]!.occupiedUntil.toISOString()).toBe("2026-11-09T10:45:00.000Z");
  });

  it("правило на дату перекрывает недельное; выходной — без слотов; lead time и горизонт", () => {
    const rules = [
      weekly(1, 600, 840),
      { dayOfWeek: null, date: MONDAY, closed: true, opensMin: null, closesMin: null },
    ];
    expect(generateSlots(resource, rules, MONDAY, 1, TZ, NOW)).toEqual([]);
    expect(
      windowsOn(
        [
          weekly(1, 600, 840),
          { ...weekly(1, 0, 0), dayOfWeek: null, date: MONDAY, opensMin: 900, closesMin: 960 },
        ],
        MONDAY,
        1,
      ),
    ).toEqual([[900, 960]]);
    // now = 08:30 UTC понедельника, lead 60 → первый слот не раньше 09:30 UTC.
    const late = generateSlots(
      resource,
      [weekly(1, 600, 840)],
      MONDAY,
      1,
      TZ,
      new Date("2026-11-09T08:30:00Z"),
    );
    expect(late[0]!.startsAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    const short = generateSlots({ ...resource, horizon_days: 1 }, [weekly(1, 600, 840)], MONDAY, 1, TZ, NOW);
    // Горизонт 1 день от NOW (воскресенье 08:00 UTC): в понедельник — только слот ровно на границе.
    expect(short.map((s) => s.startsAt.toISOString())).toEqual(["2026-11-09T08:00:00.000Z"]);
  });

  it("DST весной (последнее воскресенье марта, Киев 03:00 → 04:00): несуществующий час пропущен, дублей нет", () => {
    const night = { ...resource, horizon_days: 60 };
    const now = new Date("2027-03-20T00:00:00Z");
    const slots = generateSlots(night, [weekly(7, 0, 360)], "2027-03-28", 1, TZ, now);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      "2027-03-27T22:00:00.000Z", // 00:00 EET
      "2027-03-27T23:00:00.000Z", // 01:00
      "2027-03-28T00:00:00.000Z", // 02:00
      "2027-03-28T01:00:00.000Z", // 04:00 EEST (03:00 не существует)
      "2027-03-28T02:00:00.000Z", // 05:00
    ]);
    // Слот на «несуществующее» 03:00 забронировать нельзя: findSlot находит только 04:00 сетки.
    expect(
      findSlot(night, [weekly(7, 0, 360)], new Date("2027-03-28T01:00:00Z"), TZ, now)?.startsAt.toISOString(),
    ).toBe("2027-03-28T01:00:00.000Z");
  });

  it("DST осенью (последнее воскресенье октября, Киев 04:00 → 03:00): каждый местный час — один слот", () => {
    const night = { ...resource, horizon_days: 60 };
    const now = new Date("2027-10-20T00:00:00Z");
    const slots = generateSlots(night, [weekly(7, 0, 360)], "2027-10-31", 1, TZ, now);
    const times = slots.map((s) => s.startsAt.getTime());
    expect(new Set(times).size).toBe(6);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
    expect(slots.map((s) => fmt.format(s.startsAt))).toEqual([
      "00:00",
      "01:00",
      "02:00",
      "03:00",
      "04:00",
      "05:00",
    ]);
  });

  it("findSlot — только начало слота сетки", () => {
    const rules = [weekly(1, 600, 840)];
    expect(findSlot(resource, rules, new Date("2026-11-09T09:00:00Z"), TZ, NOW)).toBeDefined();
    expect(findSlot(resource, rules, new Date("2026-11-09T09:30:00Z"), TZ, NOW)).toBeUndefined();
    expect(findSlot(resource, rules, new Date("2026-11-10T09:00:00Z"), TZ, NOW)).toBeUndefined();
  });

  it("свободен, если интервал занятости не пересекается ни с одной бронью (полуинтервалы)", () => {
    const [slot] = generateSlots(resource, [weekly(1, 600, 660)], MONDAY, 1, TZ, NOW);
    const before = { from: new Date("2026-11-09T07:00:00Z"), until: new Date("2026-11-09T08:00:00Z") };
    const inside = { from: new Date("2026-11-09T08:59:00Z"), until: new Date("2026-11-09T09:30:00Z") };
    expect(isFree(slot!, [before])).toBe(true);
    expect(isFree(slot!, [inside])).toBe(false);
    const occ = occupiedRange(slot!.startsAt, slot!.endsAt, { buffer_before_min: 10, buffer_after_min: 20 });
    expect(occ.from.toISOString()).toBe("2026-11-09T07:50:00.000Z");
    expect(occ.until.toISOString()).toBe("2026-11-09T09:20:00.000Z");
  });

  it("правила: пересечение окон и выходной с окнами — проблемы", () => {
    expect(rulesProblems([weekly(1, 600, 840), weekly(1, 800, 900)])).toEqual(["dow:1: overlap"]);
    expect(
      rulesProblems([
        { dayOfWeek: null, date: MONDAY, closed: true, opensMin: null, closesMin: null },
        { dayOfWeek: null, date: MONDAY, closed: false, opensMin: 600, closesMin: 700 },
      ]),
    ).toEqual([`${MONDAY}: closed_with_windows`]);
    expect(rulesProblems([weekly(1, 600, 840), weekly(2, 600, 840)])).toEqual([]);
  });
});

describe("ресурс без расписания (публичный список)", () => {
  const res = { slot_duration_min: 90, horizon_days: 30 };
  const dated = (date: string, opens: number | null, closes: number | null, closed = false): RuleInput => ({
    dayOfWeek: null,
    date,
    closed,
    opensMin: opens,
    closesMin: closes,
  });
  it("hasOpenRule: нет правил или только выходные — false; недельное окно со слотом — true", () => {
    expect(hasOpenRule(res, [], MONDAY)).toBe(false);
    expect(hasOpenRule(res, [dated(MONDAY, null, null, true)], MONDAY)).toBe(false);
    expect(hasOpenRule(res, [weekly(1, 600, 1260)], MONDAY)).toBe(true);
  });
  it("hasOpenRule: окно короче слота — false; ровно на слот — true", () => {
    expect(hasOpenRule(res, [weekly(1, 600, 660)], MONDAY)).toBe(false);
    expect(hasOpenRule(res, [weekly(1, 600, 690)], MONDAY)).toBe(true);
  });
  it("hasOpenRule: окно на дату — только от сегодня и в пределах горизонта", () => {
    expect(hasOpenRule(res, [dated("2026-11-08", 600, 720)], MONDAY)).toBe(false);
    expect(hasOpenRule(res, [dated(MONDAY, 600, 720)], MONDAY)).toBe(true);
    expect(hasOpenRule(res, [dated("2026-12-09", 600, 720)], MONDAY)).toBe(true);
    expect(hasOpenRule(res, [dated("2026-12-10", 600, 720)], MONDAY)).toBe(false);
    expect(hasOpenRule({ ...res, horizon_days: 1 }, [dated("2026-11-11", 600, 720)], MONDAY)).toBe(false);
  });
});

describe("сроки ответа (D-43, D-66)", () => {
  const now = new Date("2026-11-09T08:00:00Z");
  const at = (min: number) => new Date(now.getTime() + min * MIN);

  it("SLA партнёра: параметр ресурса, но не больше половины времени до начала и не меньше 5 мин", () => {
    expect(partnerResponseDue(now, at(600), 60)).toEqual(at(60));
    expect(partnerResponseDue(now, at(40), 60)).toEqual(at(20));
    expect(partnerResponseDue(now, at(6), 60)).toEqual(at(5));
  });

  it("ответ туриста на альтернативу: меньшее из 120 мин и «за 60 мин до начала»; слишком близко — null", () => {
    expect(customerResponseDue(now, at(300))).toEqual(at(120));
    expect(customerResponseDue(now, at(120))).toEqual(at(60));
    expect(customerResponseDue(now, at(50))).toBeNull();
  });
});

describe("«Доступно зараз» (BR-04, D-78)", () => {
  const now = new Date("2026-11-09T08:00:00Z");
  const slot = (min: number) => {
    const startsAt = new Date(now.getTime() + min * MIN);
    const endsAt = new Date(startsAt.getTime() + 60 * MIN);
    return { startsAt, endsAt, occupiedFrom: startsAt, occupiedUntil: endsAt };
  };
  const none = { status: "unknown" as const, expiresAt: null };

  it("только реальный свободный слот в ближайшие 2 ч или ручной статус с неистёкшим TTL", () => {
    expect(availabilityNow(none, [slot(90)], now)).toMatchObject({ availableNow: true, source: "slot" });
    expect(availabilityNow(none, [slot(300)], now)).toMatchObject({ availableNow: false, source: null });
    expect(availabilityNow(none, [], now).availableNow).toBe(false);
    const manual = { status: "available_now" as const, expiresAt: new Date(now.getTime() + 30 * MIN) };
    expect(availabilityNow(manual, [], now)).toMatchObject({ availableNow: true, source: "manual" });
  });

  it("истёкший ручной статус не действует; busy с неистёкшим TTL перекрывает слоты", () => {
    const expired = { status: "available_now" as const, expiresAt: new Date(now.getTime() - MIN) };
    expect(availabilityNow(expired, [], now).availableNow).toBe(false);
    const busy = { status: "busy" as const, expiresAt: new Date(now.getTime() + 30 * MIN) };
    expect(availabilityNow(busy, [slot(90)], now).availableNow).toBe(false);
  });
});

describe("отмена туристом и имя клиента (0024)", () => {
  const start = new Date("2026-11-10T10:00:00Z");
  const alt = new Date("2026-11-10T14:00:00Z");

  it("срок отмены: confirmed — за 2 ч до начала; неподтверждённая — начало; альтернатива — её начало", () => {
    expect(userCancelDeadline("confirmed", start, null)).toEqual(new Date("2026-11-10T08:00:00Z"));
    expect(userCancelDeadline("pending_partner", start, null)).toEqual(start);
    expect(userCancelDeadline("new", start, null)).toEqual(start);
    expect(userCancelDeadline("alternative_proposed", start, alt)).toEqual(alt);
    for (const s of ["cancelled_by_user", "expired", "completed", "no_show", "cancelled_by_partner"] as const)
      expect(userCancelDeadline(s, start, null)).toBeNull();
  });

  it("срок отмены совпадает с проверкой сервера (userCancelAllowed)", () => {
    for (const status of ["confirmed", "pending_partner", "new"] as const) {
      const deadline = userCancelDeadline(status, start, null)!;
      expect(userCancelAllowed(status, start, new Date(deadline.getTime() - 1))).toBe(true);
      expect(userCancelAllowed(status, start, deadline)).toBe(false);
    }
  });

  it("имя клиента: пробелы схлопываются, пустое — null, длинное — обрезается до 200 символов Unicode", () => {
    expect(normalizeCustomerName(undefined)).toBeNull();
    expect(normalizeCustomerName("   \n ")).toBeNull();
    expect(normalizeCustomerName("  Олена \t Коваль ")).toBe("Олена Коваль");
    expect(Array.from(normalizeCustomerName("Ї".repeat(250))!)).toHaveLength(200);
    // Эмодзи (суррогатная пара) не разрезается пополам.
    const emoji = normalizeCustomerName("😀".repeat(201))!;
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.endsWith("😀")).toBe(true);
    // Обрезка не оставляет пробел в конце.
    expect(normalizeCustomerName(`${"а".repeat(199)} б`)).toBe("а".repeat(199));
  });
});
