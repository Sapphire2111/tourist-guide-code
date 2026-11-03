// Unit: генератор сценариев — заказы, кандидаты, проверка программой (места только из списка, реалистичная
// длительность, дорога, график, сезон, без авто), повтор с ошибками, аргументы CLI. Модель и БД подменены.
import { describe, expect, it, vi } from "vitest";
import type { LonLat } from "../db/index.js";
import { GenArgsError, parseGenArgs } from "./args.js";
import { allBriefs, THEMES, type Brief, type ThemeCode } from "./briefs.js";
import { fitsBrief, selectCandidates, weeklyShort, type CandidateSet } from "./candidates.js";
import { genPlace, type GenCatalog, type GenPlace } from "./catalog.js";
import { emptyUsage, generateOne, pool, usd, type MessagesApi } from "./generate.js";
import { wantedReport } from "./missing.js";
import { OUTPUT_SCHEMA, parseScenario, requestParams, type GenScenario } from "./prompt.js";
import { checkDraft, openEnough, realisticMinutes, validateScenario } from "./validate.js";

const CENTER: LonLat = { lon: 24.55, lat: 48.45 };
const east = (m: number): LonLat => ({ lon: CENTER.lon + m / 73_800, lat: CENTER.lat });
let n = 0;
const place = (category: string, name: string, m: number, over: Partial<GenPlace> = {}): GenPlace =>
  genPlace({
    id: `0190f5c2-7d3e-7000-8000-${String(++n).padStart(12, "0")}`,
    name,
    names: [name],
    category,
    extraCategories: [],
    locality: "yaremche",
    location: east(m),
    tags: [],
    recommended: false,
    rating: 4.7,
    ratingCount: 100,
    typeLabel: null,
    weekly: [],
    ...over,
  });

const theme = (code: ThemeCode) => THEMES.find((t) => t.code === code)!;
const brief = (code: ThemeCode, over: Partial<Brief> = {}): Brief => ({
  code: `ai-yaremche-${code}-test-1d`,
  theme: theme(code),
  area: "yaremche",
  seasons: ["summer"],
  days: 1,
  ...over,
});
const setOf = (places: GenPlace[]): CandidateSet => {
  const candidates = places.map((p, i) => ({ ref: `p${i + 1}`, place: p, distance: 0, focus: true }));
  return {
    candidates,
    byRef: new Map(candidates.map((c) => [c.ref, c.place])),
    center: CENTER,
    viable: true,
    reason: null,
  };
};
const item = (ref: string, time: string, minutes: number, alternatives: string[] = []) => ({
  ref,
  time,
  minutes,
  note_uk: "Прогулянка",
  alternatives,
});
const scenario = (items: ReturnType<typeof item>[], over: Partial<GenScenario> = {}): GenScenario => ({
  title_uk: "День у Яремчі",
  title_en: "A day in Yaremche",
  description_uk: "Водоспад, обід і чан.",
  tags: ["waterfalls"],
  days: [{ day: 1, items }],
  ...over,
});

const khomiak = place("nature", "Гора Хом'як", 500);
const probii = place("nature", "Водоспад Пробій", 800);
const lunch = place("restaurants", "Колиба Гражда", 1000, {
  weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "11:00", closesAt: "22:00" })),
});
const chan = place("chany", "Чани", 1500);
const far = place("nature", "Далекий водоспад", 6000);

describe("briefs", () => {
  it("коды уникальны, первые — разные темы по кругу", () => {
    const all = allBriefs();
    expect(new Set(all.map((b) => b.code)).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(150);
    expect(new Set(all.slice(0, THEMES.length).map((b) => b.theme.code)).size).toBe(THEMES.length);
    expect(all.filter((b) => b.theme.code === "ski").every((b) => b.seasons.join() === "winter")).toBe(true);
  });
});

describe("кандидаты", () => {
  it("зимой без вершин; с детьми без баров и долгих походов; в дождь — под крышей; без авто — не дальше похода", () => {
    expect(fitsBrief(khomiak, brief("peak", { seasons: ["winter"] }))).toBe(false);
    expect(fitsBrief(khomiak, brief("peak"))).toBe(true);
    expect(fitsBrief(khomiak, brief("kids"))).toBe(false);
    expect(fitsBrief(place("cafes", "Пивний бар", 0), brief("kids"))).toBe(false);
    expect(fitsBrief(probii, brief("rain"))).toBe(false);
    expect(fitsBrief(place("museums", "Музей", 0), brief("rain"))).toBe(true);
    expect(fitsBrief(place("nature", "Парковка", 0), brief("waterfalls"))).toBe(false);
    expect(fitsBrief(place("excursions", "Екскурсії на Говерлу", 0), brief("culture"))).toBe(false);
    expect(fitsBrief(place("ski-resorts", "Буковель", 0), brief("active"))).toBe(false);
    expect(fitsBrief(place("ski-resorts", "Буковель", 0), brief("ski", { seasons: ["winter"] }))).toBe(true);
    // Круглый год — место должно подходить во все сезоны.
    expect(fitsBrief(khomiak, brief("dovbush", { seasons: [] }))).toBe(false);
  });

  it("selectCandidates: ссылки p1…, радиус, причина «не собрать»", () => {
    const catalog: GenCatalog = {
      regionId: "r",
      timezone: "Europe/Kyiv",
      places: [
        probii,
        lunch,
        chan,
        khomiak,
        place("cafes", "Кава", 300),
        place("nature", "Водоспад Далеко", 90_000),
      ],
      localities: [{ code: "yaremche", name: "Яремче", location: CENTER }],
      existingCodes: new Set(),
    };
    const set = selectCandidates(brief("waterfalls"), catalog);
    expect(set.candidates.map((c) => c.ref)).toEqual(set.candidates.map((_, i) => `p${i + 1}`));
    expect(set.candidates.some((c) => c.place.name === "Водоспад Далеко")).toBe(false);
    expect(set.viable).toBe(false);
    expect(set.reason).toBe("меньше 2 водоспадов");
    expect(selectCandidates(brief("peak"), catalog).viable).toBe(true);
  });

  it("weeklyShort — дни подряд с одинаковыми часами вместе", () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "09:00", closesAt: "18:00" }));
    expect(weeklyShort(all)).toBe("пн-нд 09:00-18:00");
    expect(weeklyShort(all.slice(0, 5))).toBe("пн-пт 09:00-18:00; вихідний сб,нд");
    expect(weeklyShort([])).toBe("?");
  });

  it("отчёт о недостающих: Хом'як найден по месту, Говерла — нет", () => {
    const r = wantedReport({
      regionId: "r",
      timezone: "Europe/Kyiv",
      places: [khomiak, place("hotels", "Готель Говерла", 0)],
      localities: [],
      existingCodes: new Set(),
    });
    expect(r.find((w) => w.name === "Хом'як")!.found).toHaveLength(1);
    expect(r.find((w) => w.name === "Говерла")!.found).toEqual([]);
  });
});

describe("проверка сценария", () => {
  it("поход на Хом'як — фиксированные ~6,5 год, а не 90 хв; время сдвигается на дорогу", () => {
    const set = setOf([khomiak, lunch, chan]);
    const r = validateScenario(
      brief("peak"),
      set,
      scenario([item("p1", "08:00", 90), item("p2", "10:00", 75), item("p3", "18:00", 120)]),
    );
    expect(r.errors).toEqual([]);
    const [hike, meal] = r.draft!.items;
    expect(hike!.durationMin).toBe(390);
    expect(hike!.durationMin).toBe(realisticMinutes(khomiak, 90));
    // 08:00 + 390 хв + дорога → обед не раньше 14:30.
    expect(meal!.timeHint >= "14:30").toBe(true);
    expect(r.fixes.some((f) => f.includes("тривалість 90 → 390"))).toBe(true);
    expect(r.draft!.tags).toContain("one_day");
    expect(r.draft!.seasons).toEqual(["summer"]);
  });

  it("ошибки: место не из списка, дубль, поход после 10:00, закрыто, без авто далеко, нет еды", () => {
    const set = setOf([khomiak, probii, lunch, chan, far]);
    const bad = validateScenario(
      brief("peak"),
      set,
      scenario([item("p1", "11:00", 390), item("p9", "18:00", 60), item("p1", "19:00", 60)]),
    );
    expect(bad.draft).toBeNull();
    expect(bad.errors.join("\n")).toMatch(/до 10:00/);
    expect(bad.errors.join("\n")).toMatch(/немає в списку кандидатів/);
    expect(bad.errors.join("\n")).toMatch(/повторюється/);

    const closed = validateScenario(
      brief("gastro"),
      set,
      scenario([item("p2", "08:00", 45), item("p3", "08:50", 75)]),
    );
    expect(closed.errors.join("\n")).toMatch(/зачинено/);

    const foot = validateScenario(
      brief("no-car"),
      set,
      scenario([item("p2", "10:00", 45), item("p5", "11:00", 60), item("p3", "13:00", 75)]),
    );
    expect(foot.errors.join("\n")).toMatch(/без авто/);

    const hungry = validateScenario(
      brief("waterfalls"),
      set,
      scenario([item("p2", "10:00", 45), item("p5", "11:00", 60), item("p4", "14:00", 120)]),
    );
    expect(hungry.errors.join("\n")).toMatch(/немає де поїсти/);
  });

  it("та же точка под двумя карточками — ошибка; неверная альтернатива снимается", () => {
    const twin = place("nature", "Пробій оглядовий камінь", 810);
    const set = setOf([probii, twin, lunch]);
    const r = validateScenario(
      brief("waterfalls"),
      set,
      scenario([item("p1", "10:00", 45, ["p9", "p1"]), item("p2", "11:00", 60), item("p3", "13:00", 75)]),
    );
    expect(r.errors.join("\n")).toMatch(/те саме місце/);
    const ok = validateScenario(
      brief("waterfalls"),
      setOf([probii, lunch, chan]),
      scenario([
        item("p1", "10:00", 45, ["p9", "p1", "p3"]),
        item("p2", "12:00", 75),
        item("p3", "15:00", 120),
      ]),
    );
    expect(ok.draft!.items[0]!.alternatives).toEqual([chan.id]);
  });

  it("openEnough: график неизвестен — да; через полночь", () => {
    expect(openEnough(probii, 600, 700)).toBe(true);
    const night = place("chany", "Нічні чани", 0, {
      weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "10:00", closesAt: "02:00" })),
    });
    expect(openEnough(night, 21 * 60, 23 * 60)).toBe(true);
    expect(openEnough(night, 8 * 60, 9 * 60)).toBe(false);
  });
});

describe("генерация", () => {
  const set = setOf([probii, lunch, chan]);
  const good = scenario([item("p1", "10:00", 45), item("p2", "12:00", 75), item("p3", "15:00", 120)]);
  const res = (text: string) => ({
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    },
    content: [{ type: "text", text }],
  });

  it("структурированный ответ, ошибки проверки — повтор с их перечнем", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        res(JSON.stringify(scenario([item("p7", "10:00", 45), item("p2", "12:00", 75)]))),
      )
      .mockResolvedValueOnce(res(JSON.stringify(good)));
    const usage = emptyUsage();
    const r = await generateOne({ create } as unknown as MessagesApi, brief("waterfalls"), set, usage, {
      retries: 1,
    });
    expect(r.draft?.items).toHaveLength(3);
    expect(r.attempts).toBe(2);
    expect(usage).toEqual({ input: 2000, cacheWrite: 100, cacheRead: 200, output: 1000, requests: 2 });
    // 2000×2 + 100×2,5 + 200×0,2 + 1000×10 = 14 290 мкдолл. → $0,01
    expect(usd(usage)).toBe(0.01);
    const second = create.mock.calls[1]![0] as { messages: { content: string }[] };
    expect(second.messages[0]!.content).toMatch(/не пройшла перевірку[\s\S]*p7/);
    const params = requestParams(brief("waterfalls"), set);
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.output_config).toMatchObject({ format: { type: "json_schema", schema: OUTPUT_SCHEMA } });
  });

  it("не JSON и отказ — сценарий отброшен", async () => {
    const create = vi.fn().mockResolvedValue(res("не json"));
    const r = await generateOne(
      { create } as unknown as MessagesApi,
      brief("waterfalls"),
      set,
      emptyUsage(),
      { retries: 0 },
    );
    expect(r.draft).toBeNull();
    expect(parseScenario('{"title_uk":"x","days":[]}')).toMatchObject({ title_uk: "x", tags: [] });
  });

  it("pool — порядок как у входа, не больше concurrency одновременно", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

describe("аргументы", () => {
  it("по умолчанию — 10 черновиками; --dry-run требует --out; темы проверяются", () => {
    expect(parseGenArgs([])).toMatchObject({
      count: 10,
      dryRun: false,
      publish: false,
      region: "test-region",
    });
    expect(parseGenArgs(["--dry-run", "--out", "x.json", "--count", "3"])).toMatchObject({
      dryRun: true,
      count: 3,
    });
    expect(() => parseGenArgs(["--dry-run"])).toThrow(GenArgsError);
    expect(() => parseGenArgs(["--dry-run", "--publish", "--out", "x"])).toThrow(GenArgsError);
    expect(() => parseGenArgs(["--theme", "space"])).toThrow(GenArgsError);
    expect(parseGenArgs(["--plan"]).dryRun).toBe(true);
  });
});

describe("--from-file: проверка готового сценария", () => {
  it("валидный проходит; неизвестный тег/сезон, день вне days, нереальная длительность, место не из каталога — нет", () => {
    const set = setOf([khomiak, lunch, chan]);
    const draft = validateScenario(
      brief("peak"),
      set,
      scenario([item("p1", "08:00", 390), item("p2", "15:00", 75), item("p3", "18:00", 120)]),
    ).draft!;
    const byId = new Map([khomiak, lunch, chan].map((x) => [x.id, x]));
    expect(checkDraft(draft, byId)).toEqual([]);
    const broken = {
      ...draft,
      tags: [...draft.tags, "space"],
      seasons: ["monsoon"],
      items: [
        { ...draft.items[0]!, durationMin: 90 },
        { ...draft.items[1]!, dayNo: 3 },
        { ...draft.items[2]!, placeId: "0190f5c2-7d3e-7000-8000-999999999999" },
      ],
    } as unknown as typeof draft;
    const errors = checkDraft(broken, byId).join("\n");
    expect(errors).toMatch(/невідомі теги/);
    expect(errors).toMatch(/невідомі сезони/);
    expect(errors).toMatch(/нереальна/);
    expect(errors).toMatch(/день поза/);
    expect(errors).toMatch(/немає серед опублікованих/);
    // Зимний сезон для похода на вершину — нет.
    expect(checkDraft({ ...draft, seasons: ["winter"] }, byId).join()).toMatch(/сезону winter/);
  });
});
