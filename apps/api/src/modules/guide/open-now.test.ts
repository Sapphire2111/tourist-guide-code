// Unit: «Відкрито зараз» по графику места в таймзоне региона (блок 4, ADR-0019).
import { describe, expect, it } from "vitest";
import { localMoment, openState, type LocalMoment, type ScheduleRows } from "./open-now.js";

/** Момент: дата (YYYY-MM-DD), ISO день недели, время HH:MM. */
const at = (date: string, dayOfWeek: number, time: string, previousDate = "prev"): LocalMoment => ({
  date,
  previousDate,
  dayOfWeek,
  minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
});

const weekdays9to18: ScheduleRows = {
  weekly: [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, opensAt: "09:00:00", closesAt: "18:00:00" })),
  exceptions: [],
};

describe("localMoment", () => {
  it("местные дата, день недели и минуты в таймзоне региона (Kyiv: UTC+2 зимой, UTC+3 летом)", () => {
    // 2026-11-02 — понедельник; 22:30 UTC = 00:30 вторника по Киеву.
    expect(localMoment(new Date("2026-11-02T22:30:00Z"), "Europe/Kyiv")).toEqual({
      date: "2026-11-03",
      previousDate: "2026-11-02",
      dayOfWeek: 2,
      minutes: 30,
    });
    expect(localMoment(new Date("2026-07-05T09:15:00Z"), "Europe/Kyiv")).toMatchObject({
      date: "2026-07-05",
      dayOfWeek: 7,
      minutes: 12 * 60 + 15,
    });
    // Переход через месяц и год.
    expect(localMoment(new Date("2027-01-01T00:10:00Z"), "Europe/Kyiv").previousDate).toBe("2026-12-31");
  });
});

describe("openState", () => {
  it("пустой график — неизвестно (null)", () => {
    expect(openState({ weekly: [], exceptions: [] }, at("2026-11-02", 1, "12:00"))).toEqual({
      openNow: null,
      openUntil: null,
    });
  });

  it("внутри интервала — открыто до закрытия; на границе закрытия и в выходной — закрыто", () => {
    expect(openState(weekdays9to18, at("2026-11-02", 1, "09:00"))).toEqual({
      openNow: true,
      openUntil: "18:00",
    });
    expect(openState(weekdays9to18, at("2026-11-02", 1, "17:59")).openNow).toBe(true);
    expect(openState(weekdays9to18, at("2026-11-02", 1, "18:00")).openNow).toBe(false);
    expect(openState(weekdays9to18, at("2026-11-02", 1, "08:59")).openNow).toBe(false);
    expect(openState(weekdays9to18, at("2026-11-08", 7, "12:00"))).toEqual({
      openNow: false,
      openUntil: null,
    });
  });

  it("несколько интервалов в день (обед)", () => {
    const s: ScheduleRows = {
      weekly: [
        { dayOfWeek: 3, opensAt: "09:00", closesAt: "13:00" },
        { dayOfWeek: 3, opensAt: "14:00", closesAt: "19:00" },
      ],
      exceptions: [],
    };
    expect(openState(s, at("2026-11-04", 3, "13:30")).openNow).toBe(false);
    expect(openState(s, at("2026-11-04", 3, "14:30"))).toEqual({ openNow: true, openUntil: "19:00" });
  });

  it("через полночь: вечер дня интервала и утро следующего", () => {
    const bar: ScheduleRows = {
      weekly: [{ dayOfWeek: 5, opensAt: "20:00", closesAt: "02:00" }],
      exceptions: [],
    };
    expect(openState(bar, at("2026-11-06", 5, "23:00"))).toEqual({ openNow: true, openUntil: "02:00" });
    expect(openState(bar, at("2026-11-07", 6, "01:30", "2026-11-06"))).toEqual({
      openNow: true,
      openUntil: "02:00",
    });
    expect(openState(bar, at("2026-11-07", 6, "02:00", "2026-11-06")).openNow).toBe(false);
    // Воскресенье → понедельник: вчера = 7.
    const sun: ScheduleRows = {
      weekly: [{ dayOfWeek: 7, opensAt: "22:00", closesAt: "03:00" }],
      exceptions: [],
    };
    expect(openState(sun, at("2026-11-09", 1, "01:00", "2026-11-08")).openNow).toBe(true);
  });

  it("исключения: закрыто весь день, свои интервалы вместо недельных; без недельного графика — по исключению", () => {
    const closed: ScheduleRows = {
      ...weekdays9to18,
      exceptions: [{ date: "2026-11-02", closed: true, opensAt: null, closesAt: null }],
    };
    expect(openState(closed, at("2026-11-02", 1, "12:00"))).toEqual({ openNow: false, openUntil: null });
    const short: ScheduleRows = {
      ...weekdays9to18,
      exceptions: [{ date: "2026-11-02", closed: false, opensAt: "10:00:00", closesAt: "14:00:00" }],
    };
    expect(openState(short, at("2026-11-02", 1, "09:30")).openNow).toBe(false);
    expect(openState(short, at("2026-11-02", 1, "13:00"))).toEqual({ openNow: true, openUntil: "14:00" });
    expect(openState(short, at("2026-11-02", 1, "15:00")).openNow).toBe(false);
    const onlyException: ScheduleRows = {
      weekly: [],
      exceptions: [{ date: "2026-11-02", closed: false, opensAt: "10:00", closesAt: "12:00" }],
    };
    expect(openState(onlyException, at("2026-11-02", 1, "11:00")).openNow).toBe(true);
    expect(openState(onlyException, at("2026-11-04", 3, "11:00")).openNow).toBeNull();
  });
});

describe("openState: круглосуточно", () => {
  const allDay = (closesAt: string): ScheduleRows => ({
    weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "00:00", closesAt })),
    exceptions: [],
  });
  it("00:00–23:59 и 00:00–24:00: открыто в любой час, времени закрытия нет", () => {
    for (const closes of ["23:59", "24:00", "23:59:00"])
      for (const time of ["00:00", "12:30", "23:59"])
        expect(openState(allDay(closes), at("2026-06-03", 3, time))).toEqual({
          openNow: true,
          openUntil: null,
        });
  });
  it("смешанная неделя: круглосуточный день открыт, обычный по часам, выходной закрыт", () => {
    const s: ScheduleRows = {
      weekly: [
        { dayOfWeek: 3, opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: 4, opensAt: "09:00", closesAt: "18:00" },
      ],
      exceptions: [],
    };
    expect(openState(s, at("2026-06-03", 3, "03:00")).openNow).toBe(true);
    expect(openState(s, at("2026-06-04", 4, "03:00")).openNow).toBe(false);
    expect(openState(s, at("2026-06-05", 5, "12:00")).openNow).toBe(false);
  });
});
