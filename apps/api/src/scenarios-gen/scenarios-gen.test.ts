// Unit: генератор сценариев — заказы, кандидаты, проверка программой (места только из списка, реалистичная
// длительность, дорога, график, сезон, без авто), повтор с ошибками, аргументы CLI. Модель и БД подменены.
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { LonLat } from "../db/index.js";
import { GenArgsError, parseGenArgs } from "./args.js";
import { allBriefs, targetBriefs, TARGET_THEMES, THEMES, type Brief, type ThemeCode } from "./briefs.js";
import { fitsBrief, selectCandidates, weeklyShort, type CandidateSet } from "./candidates.js";
import { genPlace, type GenCatalog, type GenPlace } from "./catalog.js";
import {
  answerText,
  emptyUsage,
  generateOne,
  pool,
  usd,
  type GenOutcome,
  type MessagesApi,
  type Usage,
} from "./generate.js";
import {
  latestByCode,
  openJournal,
  parseScenariosFile,
  readJournal,
  readyCodes,
  runPaths,
  totalUsage,
  type GenRecord,
} from "./journal.js";
import { wantedReport } from "./missing.js";
import { mapCategory } from "../places-import/mapping.js";
import {
  CRITIC_SYSTEM,
  GEN_MAX_TOKENS,
  OUTPUT_SCHEMA,
  parseScenario,
  priceOf,
  requestParams,
  SYSTEM_PROMPT,
  type GenScenario,
} from "./prompt.js";
import { chooseOrders, planEstimate, runOrders, summarize, type Order } from "./run.js";
import {
  checkDraft,
  DESCRIPTION_ASK_MAX,
  draftToGen,
  NOTE_ASK_MAX,
  NOTE_MAX,
  openEnough,
  realisticMinutes,
  stripSchedule,
  TITLE_ASK_MAX,
  TITLE_MAX,
  trimNote,
  validateScenario,
  type ScenarioDraft,
} from "./validate.js";
import { eachIsolated } from "./writer.js";

/** Поток модели в тестах: finalMessage отдаёт ответ подменённой функции. */
const api = (create: (params: unknown) => unknown) =>
  ({
    stream: (params: unknown) => ({ finalMessage: () => Promise.resolve(create(params)) }),
  }) as unknown as MessagesApi;

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
    priceLevel: null,
    summary: null,
    weekly: [],
    ...over,
  });

/** Текст запроса к модели (строка или блоки). */
const textOf = (params: unknown): string => {
  const c = (params as { messages: { content: string | { text: string }[] }[] }).messages[0]!.content;
  return typeof c === "string" ? c : c.map((x) => x.text).join("\n");
};

const theme = (code: ThemeCode) => [...THEMES, ...TARGET_THEMES].find((t) => t.code === code)!;
const brief = (code: ThemeCode, over: Partial<Brief> = {}): Brief => ({
  code: `ai-yaremche-${code}-test-1d`,
  theme: theme(code),
  area: "yaremche",
  seasons: ["summer"],
  days: 1,
  ...over,
});
const setOf = (places: GenPlace[]): CandidateSet => {
  const candidates = places.map((p, i) => ({
    ref: `p${i + 1}`,
    place: p,
    distance: 0,
    focus: true,
    used: 0,
  }));
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
      scenario([item("p1", "08:00", 90, ["p3"]), item("p2", "10:00", 75), item("p3", "18:00", 120)]),
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
  const good = scenario([item("p1", "10:00", 45, ["p3"]), item("p2", "12:00", 75), item("p3", "15:00", 120)]);
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
    const r = await generateOne(api(create), brief("waterfalls"), set, usage, {
      retries: 1,
    });
    expect(r.draft?.items).toHaveLength(3);
    expect(r.attempts).toBe(2);
    expect(usage).toMatchObject({ input: 2000, cacheWrite: 100, cacheRead: 200, output: 1000, requests: 2 });
    // Opus 5.5: 2000×4 + 100×5 + 200×0,2 + 1000×20 = 28 540 мкдолл. → $0,03
    expect(usage.costUsd).toBeCloseTo(28_540 / 1e6, 9);
    expect(usd(usage)).toBe(0.03);
    const second = create.mock.calls[1]![0] as { messages: { content: string }[] };
    expect(second.messages[0]!.content).toMatch(/не пройшла перевірку[\s\S]*p7/);
    const params = requestParams(brief("waterfalls"), set);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config).toMatchObject({ format: { type: "json_schema", schema: OUTPUT_SCHEMA } });
  });

  it("не JSON и отказ — сценарий отброшен", async () => {
    const create = vi.fn().mockResolvedValue(res("не json"));
    const r = await generateOne(api(create), brief("waterfalls"), set, emptyUsage(), { retries: 0 });
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
  it("по умолчанию — 10 черновиками; --out обязателен при генерации; темы проверяются", () => {
    expect(parseGenArgs(["--out", "x.json"])).toMatchObject({
      count: 10,
      dryRun: false,
      publish: false,
      region: "test-region",
      maxUsd: null,
      skipFailed: false,
    });
    expect(() => parseGenArgs([])).toThrow(/--out/);
    expect(() => parseGenArgs(["--count", "200"])).toThrow(/--out/);
    expect(parseGenArgs(["--from-file", "x.jsonl"]).fromFile).toBe("x.jsonl");
    expect(() => parseGenArgs(["--from-file", "x.jsonl", "--dry-run"])).toThrow(/--out/);
    expect(parseGenArgs(["--out", "x", "--max-usd", "12.5", "--skip-failed"])).toMatchObject({
      maxUsd: 12.5,
      skipFailed: true,
    });
    expect(() => parseGenArgs(["--out", "x", "--max-usd", "0"])).toThrow(GenArgsError);
    expect(() => parseGenArgs(["--out", "x", "--max-usd", "abc"])).toThrow(GenArgsError);
    expect(() => parseGenArgs(["--from-file", "x", "--max-usd", "1"])).toThrow(GenArgsError);
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
      scenario([item("p1", "08:00", 390, ["p3"]), item("p2", "15:00", 75), item("p3", "18:00", 120)]),
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
    // Повтор места, альтернатива не по сезону, не-localized описание, мусор вместо пунктов — ошибки, не исключения.
    const twice = {
      ...draft,
      items: [draft.items[0]!, { ...draft.items[0]!, dayNo: 1 }, ...draft.items.slice(1)],
    };
    expect(checkDraft(twice, byId).join()).toMatch(/повторюється/);
    const winterAlt = {
      ...draft,
      seasons: ["winter" as const],
      items: [{ ...draft.items[1]!, alternatives: [khomiak.id] }, draft.items[2]!],
    };
    expect(checkDraft(winterAlt, byId).join()).toMatch(/альтернатива .* не для сезону winter/);
    expect(checkDraft({ ...draft, description: "текст" }, byId).join()).toMatch(/опис — не localized/);
    expect(checkDraft({ ...draft, title: { en: "No uk" } }, byId).join()).toMatch(/назва/);
    expect(checkDraft({ ...draft, items: [null, 5, "x"] }, byId).join()).toMatch(/пункт 1 — не обʼєкт/);
    expect(checkDraft(null, byId)).toEqual(["сценарій — не обʼєкт"]);
    // Регистр id не важен.
    const upper = { ...draft, items: draft.items.map((i) => ({ ...i, placeId: i.placeId.toUpperCase() })) };
    expect(checkDraft(upper, byId)).toEqual([]);
    // Зимний сезон для похода на вершину — нет.
    expect(checkDraft({ ...draft, seasons: ["winter"] }, byId).join()).toMatch(/сезону winter/);
  });
});

describe("комфорт туриста (решение владельца 03.11.2026)", () => {
  const museum = place("museums", "Музей Гуцульщини", 1100);
  it("зимой надворі — до заката; поход — с запасом 30 хв", () => {
    const set = setOf([probii, lunch, chan, museum]);
    const r = validateScenario(
      brief("waterfalls", { seasons: ["winter"] }),
      set,
      scenario([item("p2", "12:00", 75), item("p1", "16:00", 45, ["p4"]), item("p3", "18:00", 120)]),
    );
    expect(r.errors.join("\n")).toMatch(/після заходу сонця \(16:15/);
  });

  it("обед в окне 11:30–15:30; запасной вариант на дождь; с детьми — одна большая активность", () => {
    const set = setOf([probii, lunch, chan, museum]);
    const late = validateScenario(
      brief("waterfalls"),
      set,
      scenario([item("p1", "10:00", 45, ["p4"]), item("p4", "11:00", 60), item("p2", "16:30", 75)]),
    );
    expect(late.errors.join("\n")).toMatch(/немає обіду/);
    const noAlt = validateScenario(
      brief("waterfalls"),
      set,
      scenario([item("p1", "10:00", 45), item("p2", "12:00", 75), item("p3", "15:00", 120)]),
    );
    expect(noAlt.errors.join("\n")).toMatch(/запасного варіанту на дощ/);
    const zoo = place("kids", "Звіринець", 900);
    const park = place("entertainment", "Парк розваг", 950);
    const kids = validateScenario(
      brief("kids"),
      setOf([zoo, park, lunch, museum]),
      scenario([item("p1", "10:00", 180, ["p4"]), item("p3", "13:15", 75), item("p2", "14:45", 180)]),
    );
    expect(kids.errors.join("\n")).toMatch(/з дітьми — не більше однієї великої/);
  });

  it("зигзаг по карте — ошибка; место-цель обязательно", () => {
    const a = place("nature", "Водоспад А", 0);
    const far1 = place("nature", "Водоспад Б", 12_000);
    const c = place("restaurants", "Колиба Б", 200, {
      weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "09:00", closesAt: "22:00" })),
    });
    const set = setOf([a, far1, c, museum]);
    const zig = validateScenario(
      brief("waterfalls"),
      set,
      scenario([item("p1", "09:00", 60, ["p4"]), item("p2", "10:30", 60), item("p3", "12:30", 75)]),
    );
    expect(zig.errors.join("\n")).not.toMatch(/зигзаг/);
    const set2 = setOf([a, far1, c, museum, place("nature", "Водоспад В", 12_100)]);
    const zz = validateScenario(
      brief("waterfalls"),
      set2,
      scenario([
        item("p1", "08:00", 60, ["p4"]),
        item("p2", "09:30", 60),
        item("p3", "11:30", 75),
        item("p5", "13:30", 60),
      ]),
    );
    expect(zz.errors.join("\n")).toMatch(/зигзагом/);
    const targeted = validateScenario(
      { ...brief("summit"), target: { placeId: khomiak.id, name: "Хом'як", location: khomiak.location } },
      setOf([probii, lunch, chan]),
      scenario([item("p1", "10:00", 45, ["p3"]), item("p2", "12:00", 75), item("p3", "15:00", 120)]),
    );
    expect(targeted.errors.join("\n")).toMatch(/немає обовʼязкового пункту «Хом'як»/);
  });

  it("место не каждый день — график в примечание (ринок у Косові по суботах)", () => {
    const market = place("markets", "Косівський ринок", 300, {
      weekly: [{ dayOfWeek: 6, opensAt: "06:00", closesAt: "13:00" }],
    });
    const r = validateScenario(
      brief("culture"),
      setOf([market, lunch, museum]),
      scenario([item("p1", "08:00", 60, ["p3"]), item("p3", "10:00", 60), item("p2", "12:00", 75)]),
    );
    expect(r.errors).toEqual([]);
    expect(r.draft!.items[0]!.note!.uk).toMatch(/Графік: сб 06:00-13:00/);
  });

  it("targetBriefs: вершины, скит, ринок — по одному месту на ключ, коды стабильны", () => {
    const hoverla = place("nature", "Говерла", 0, { ratingCount: 5000 });
    const hoverla2 = place("nature", "Hoverla", 10, { ratingCount: 10 });
    const skete = place("sights", "Манявський скит", 0);
    const market = place("markets", "Косівський ринок", 0, { locality: "kosiv" });
    const briefs = targetBriefs([hoverla, hoverla2, skete, market, place("hotels", "Готель Говерла", 0)]);
    const codes = briefs.map((b) => b.code);
    expect(codes).toContain("ai-summit-hoverla-sa-1d");
    expect(codes).toContain("ai-summit-hoverla-s-1d");
    expect(codes).toContain("ai-maniava-spsa-1d");
    expect(codes).toContain("ai-kosiv-market-all-1d");
    expect(briefs.find((b) => b.code === "ai-summit-hoverla-s-1d")!.target!.placeId).toBe(hoverla.id);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("2 раунда критика: «Графік: …» в примечании один раз, критик видит примечание без него", async () => {
    const market = place("markets", "Косівський ринок", 300, {
      weekly: [{ dayOfWeek: 6, opensAt: "06:00", closesAt: "13:00" }],
    });
    const museum2 = place("museums", "Музей Косова", 1100);
    const set = setOf([market, lunch, museum2]);
    const base = (note: string) =>
      scenario([
        { ...item("p1", "08:00", 60, ["p3"]), note_uk: note },
        item("p3", "10:00", 60),
        item("p2", "12:00", 75),
      ]);
    const res = (o: unknown) => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify(o) }],
    });
    // Критик копирует примечание с приписанным графиком — программа не дублирует.
    const create = vi
      .fn()
      .mockResolvedValueOnce(res(base("Приходьте рано.")))
      .mockResolvedValueOnce(
        res({ verdict: "fix", issues: ["a"], revised: base("Приходьте рано. Графік: сб 06:00-13:00.") }),
      )
      .mockResolvedValueOnce(
        res({ verdict: "fix", issues: ["b"], revised: base("Приходьте о 7:00. Графік: сб 06:00-13:00.") }),
      );
    const r = await generateOne(api(create), brief("culture"), set, emptyUsage(), {
      retries: 0,
      criticRounds: 2,
    });
    const note = r.draft!.items[0]!.note!.uk;
    expect(note).toBe("Приходьте о 7:00. Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд.");
    expect(note.match(/Графік:/g)).toHaveLength(1);
    const toCritic = textOf(create.mock.calls[2]![0]);
    expect(toCritic.split("Чернетка (JSON):")[1]).not.toMatch(/Графік:/);
  });

  it("критик: правка принимается, только если проходит проверку; «ok» — конец", async () => {
    const set = setOf([probii, lunch, chan]);
    const good = scenario([
      item("p1", "10:00", 45, ["p3"]),
      item("p2", "12:00", 75),
      item("p3", "15:00", 120),
    ]);
    const better = scenario([
      item("p1", "09:30", 45, ["p3"]),
      item("p2", "12:00", 75),
      item("p3", "16:00", 120),
    ]);
    const bad = scenario([item("p9", "09:30", 45)]);
    const res = (o: unknown) => ({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify(o) }],
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(res(good))
      .mockResolvedValueOnce(res({ verdict: "fix", issues: ["неіснуюче місце"], revised: bad }))
      .mockResolvedValueOnce(res({ verdict: "fix", issues: ["раніше на водоспад"], revised: better }))
      .mockResolvedValueOnce(res({ verdict: "ok", issues: [], revised: better }));
    const r = await generateOne(api(create), brief("waterfalls"), set, emptyUsage(), {
      retries: 0,
      criticRounds: 3,
    });
    expect(r.critic.map((c) => [c.verdict, c.accepted])).toEqual([
      ["fix", false],
      ["fix", true],
      ["ok", true],
    ]);
    expect(r.draft!.items[0]!.timeHint).toBe("09:30");
    // Второй раунд критика получил ошибки программы.
    const second = create.mock.calls[2]![0] as {
      model: string;
      fallbacks: unknown;
      betas: string[];
      system: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    expect(textOf(second)).toMatch(/не пройшло перевірку програмою[\s\S]*p9/);
    // Кэш: системный промпт и постановка с кандидатами; запасная модель при отказе.
    expect(second.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(second.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(second.messages[0]!.content[1]!.cache_control).toBeUndefined();
    expect(second).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(second.model).toBe("claude-opus-5-5");
  });
});

describe("приписка «Графік: …» и совет туриста", () => {
  it("снимается только график: совет после и до него остаётся", () => {
    expect(stripSchedule("Графік: сб 06:00-13:00. Приходьте о 7:00 і беріть готівку.")).toBe(
      "Приходьте о 7:00 і беріть готівку.",
    );
    expect(stripSchedule("Беріть готівку. Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд.")).toBe(
      "Беріть готівку.",
    );
    expect(stripSchedule("Зранку. Графік: пн-пт 09:00-13:00,14:00-18:00. Беріть готівку.")).toBe(
      "Зранку. Беріть готівку.",
    );
    // Обрезано лимитом длины примечания.
    expect(stripSchedule("Зранку. Графік: пн 09:00-13:00,14:00-18")).toBe("Зранку.");
    // Свой текст модели без часов — не приписка программы.
    expect(stripSchedule("Графік: за домовленістю, телефонуйте.")).toBe(
      "Графік: за домовленістю, телефонуйте.",
    );
    expect(stripSchedule("Без графіка.")).toBe("Без графіка.");
  });

  it("ринок: совет после графика доходит до туриста, график один", () => {
    const market = place("markets", "Косівський ринок", 300, {
      weekly: [{ dayOfWeek: 6, opensAt: "06:00", closesAt: "13:00" }],
    });
    const r = validateScenario(
      brief("culture"),
      setOf([market, lunch, place("museums", "Музей", 1100)]),
      scenario([
        {
          ...item("p1", "08:00", 60, ["p3"]),
          note_uk: "Графік: сб 06:00-13:00. Приходьте о 7:00 і беріть готівку.",
        },
        item("p3", "10:00", 60),
        item("p2", "12:00", 75),
      ]),
    );
    expect(r.draft!.items[0]!.note!.uk).toBe(
      "Приходьте о 7:00 і беріть готівку. Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд.",
    );
  });
});

describe("примечание без обрыва", () => {
  const filler = "Вирушайте зранку, поки мало людей на стежці й легко знайти місце для авто. "
    .repeat(6)
    .trim();
  const market = () =>
    place("markets", "Косівський ринок", 300, {
      weekly: [{ dayOfWeek: 6, opensAt: "06:00", closesAt: "13:00" }],
    });
  const validate = (note: string, first = probii) => {
    const museum = place("museums", "Музей", 1100);
    return validateScenario(
      brief("culture"),
      setOf([first, lunch, museum]),
      scenario([
        { ...item("p1", "08:00", 60, ["p3"]), note_uk: note },
        item("p3", "10:00", 60),
        item("p2", "12:00", 75),
      ]),
    );
  };

  it.each([
    ["двоеточие", "Розвертатися зручно у Ворохті. Правило розвороту:", "Розвертатися зручно у Ворохті."],
    ["слово оборвано", "Це святе місце. Поводьтеся тихо. Вра", "Це святе місце. Поводьтеся тихо."],
  ])("реальный обрыв из пилота (%s) не доходит до туриста", (_n, raw, want) => {
    expect(trimNote(raw)).toBe(want);
    const r = validate(raw);
    expect(r.draft!.items[0]!.note!.uk).toBe(want);
    expect(r.fixes.join()).toMatch(/скорочено до закінченого речення/);
  });

  it("длинное режется по последнему предложению в пределах лимита, с записью в fixes", () => {
    const raw = `${filler} Поводьтеся тихо. Враховуйте, що на стежці бувають інші туристи і треба йти дуже обережно.`;
    expect(raw.length).toBeGreaterThan(NOTE_MAX);
    const r = validate(raw);
    const note = r.draft!.items[0]!.note!.uk;
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).toMatch(/[.!?]$/);
    expect(raw.startsWith(note)).toBe(true);
    expect(r.fixes.join()).toMatch(/→/);
  });

  it("лимит: длина в промпте — и у модели, и у критика; предел программы не меньше", () => {
    expect(SYSTEM_PROMPT).toContain(`до ${NOTE_ASK_MAX} символів`);
    expect(CRITIC_SYSTEM).toContain(`до ${NOTE_ASK_MAX} символів`);
    expect(NOTE_MAX).toBeGreaterThanOrEqual(NOTE_ASK_MAX);
  });

  it("без точек: короткое остаётся, длинное и хвост с двоеточием — без примечания, но с fixes", () => {
    expect(trimNote("Прогулянка")).toBe("Прогулянка");
    const long = "йти далі стежкою вздовж річки ".repeat(30);
    const r = validate(long);
    expect(r.errors).toEqual([]);
    expect(r.draft!.items[0]!.note).toBeNull();
    expect(r.fixes.join()).toMatch(/примітку прибрано/);
    expect(trimNote("Правило розвороту:")).toBe("");
    expect(trimNote("")).toBe("");
  });

  it("точка после сокращения и числа — не конец предложения", () => {
    const tail = "а далі".repeat(100);
    expect(trimNote(`Парковка біля храму. Їдьте у м. Яремче ${tail}`)).toBe("Парковка біля храму.");
    expect(trimNote("Вул. Свободи поруч")).toBe("Вул. Свободи поруч");
    expect(trimNote(`Беріть воду. Це прибл. три години ${tail}`)).toBe("Беріть воду.");
    expect(trimNote(`Беріть воду! Старт о 10.30 ${tail}`)).toBe("Беріть воду!");
    expect(trimNote(`Скажіть «Добрий день!» Далі ${tail}`)).toBe("Скажіть «Добрий день!»");
  });

  it("приписка графика у длинного примечания: целая, советы не вытеснены", () => {
    const m = market();
    const raw = `${filler} Беріть готівку.`;
    expect(raw.length).toBeLessThanOrEqual(NOTE_MAX);
    const note = validate(raw, m).draft!.items[0]!.note!.uk;
    expect(note).toBe(`${raw} Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд.`);
    // Совет оборван, график остаётся целым; без совета — один график.
    expect(validate("Правило:", m).draft!.items[0]!.note!.uk).toBe(
      "Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд.",
    );
  });

  it("повторная проверка не портит текст: draftToGen → validate и checkDraft", () => {
    const m = market();
    const museum = place("museums", "Музей", 1100);
    const set = setOf([m, lunch, museum]);
    const gen = scenario([
      { ...item("p1", "08:00", 60, ["p3"]), note_uk: `${filler} Беріть готівку. Правило розвороту:` },
      item("p3", "10:00", 60),
      item("p2", "12:00", 75),
    ]);
    const first = validateScenario(brief("culture"), set, gen).draft!;
    const again = validateScenario(brief("culture"), set, draftToGen(first, set));
    expect(again.draft!.items.map((i) => i.note)).toEqual(first.items.map((i) => i.note));
    expect(again.fixes.join()).not.toMatch(/примітку/);
    const byId = new Map([m, lunch, museum].map((x) => [x.id, x]));
    expect(checkDraft(first, byId)).toEqual([]);
  });
});

describe("назва и опис без обрыва", () => {
  const set = setOf([probii, lunch, chan]);
  const items = [item("p1", "10:00", 45, ["p3"]), item("p2", "12:00", 75), item("p3", "15:00", 120)];
  const check = (over: Partial<GenScenario>) =>
    validateScenario(brief("waterfalls"), set, scenario(items, over));
  const long = "Дуже довга назва сценарію про водоспади Карпат ".repeat(3).trim();
  const byId = new Map([probii, lunch, chan].map((x) => [x.id, x]));
  const draft = () => check({}).draft!;

  it("длинная назва (uk и en) — ошибка, а не обрезка", () => {
    expect(check({ title_uk: long }).draft).toBeNull();
    expect(check({ title_uk: long }).errors.join()).toMatch(/назва довша/);
    expect(check({ title_en: long }).errors.join()).toMatch(/англійська назва довша/);
    expect(check({ title_uk: "Яремче: маршрут:" }).errors.join()).toMatch(/обірвана/);
    expect(check({ title_uk: "а".repeat(TITLE_MAX) }).errors).toEqual([]);
  });

  it("длинный опис — по законченному предложению, с записью в fixes; лимиты названы модели и критику", () => {
    const first = "Неспішний день біля водоспадів і обід поруч.";
    const r = check({ description_uk: `${first} ${"Далі ".repeat(90)}` });
    expect(r.draft!.description!.uk).toBe(first);
    expect(r.fixes.join()).toMatch(/опис скорочено/);
    const none = check({ description_uk: "а далі ".repeat(70) });
    expect(none.draft!.description).toBeNull();
    expect(none.fixes.join()).toMatch(/опис прибрано/);
    for (const prompt of [SYSTEM_PROMPT, CRITIC_SYSTEM]) {
      expect(prompt).toContain(`до ${TITLE_ASK_MAX} символів`);
      expect(prompt).toContain(`до ${DESCRIPTION_ASK_MAX} символів`);
    }
  });

  it("checkDraft отклоняет оборванное из журнала и пропускает целое", () => {
    const d = draft();
    expect(checkDraft(d, byId)).toEqual([]);
    const withNote = (uk: string) => ({
      ...d,
      items: [{ ...d.items[0]!, note: { uk } }, ...d.items.slice(1)],
    });
    expect(checkDraft(withNote("Поводьтеся тихо. Вра"), byId).join()).toMatch(/примітка \(uk\) обірвана/);
    expect(checkDraft(withNote("Сюди зручно. Правило розвороту:"), byId).join()).toMatch(/обірвана/);
    expect(checkDraft(withNote("Зранку. Графік: пн 09:00-13:00,14:00-18"), byId).join()).toMatch(/обірвана/);
    expect(checkDraft(withNote("Зранку. Графік: сб 06:00-13:00; вихідний пн,вт,ср,чт,пт,нд."), byId)).toEqual(
      [],
    );
    // Старая проверка резала назву ровно на 80 символов.
    const cut = long.slice(0, 80);
    expect(checkDraft({ ...d, title: { uk: cut } }, byId).join()).toMatch(/назва \(uk\) довша/);
    expect(checkDraft({ ...d, title: { uk: "Назва", en: cut } }, byId).join()).toMatch(/назва \(en\) довша/);
    expect(checkDraft({ ...d, description: { uk: "День біля води. Обід поб" } }, byId).join()).toMatch(
      /опис \(uk\) обірваний/,
    );
  });
});

describe("Женецький Гук в каталоге", () => {
  const catalogOf = (places: GenPlace[]): GenCatalog => ({
    regionId: "r",
    timezone: "Europe/Kyiv",
    places,
    localities: [{ code: "yaremche", name: "Яремче", location: CENTER }],
    existingCodes: new Set(),
  });
  // Категория — как в импорте (Google ставит водоспадам tourist_attraction, название главнее типа).
  const fromImport = (name: string, m: number) => {
    const category = mapCategory({ primaryType: "tourist_attraction" }, name);
    expect(category).toBe("nature");
    return place(category!, name, m);
  };
  const zhenets = fromImport("Водоспад Женецький Гук", 2_000);
  const small = fromImport("Водоспад Малий Гук Шешорський", 9_000);

  it("отчёт: реальные названия найдены, отдельного «Водоспад Гук» нет", () => {
    const missing = wantedReport(catalogOf([zhenets, small])).filter((w) => /Гук|Женец/.test(w.name));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.found[0]).toMatch(/Водоспад Женецький Гук/);
    // Без Женецького пункт остаётся недостающим: Малий Гук — другой водоспад.
    const none = wantedReport(catalogOf([small])).filter((w) => /Гук|Женец/.test(w.name));
    expect(none[0]!.found).toEqual([]);
    const plain = wantedReport(catalogOf([fromImport("Водоспад Гук", 2_000)]));
    expect(plain.filter((w) => /Гук|Женец/.test(w.name))[0]!.found).toHaveLength(1);
  });

  it("заказ: водоспад — кандидат темы, а Женецький и Малий Гук не считаются одним маршрутом", () => {
    const set = selectCandidates(brief("waterfalls"), catalogOf([zhenets, small, lunch, chan, probii]));
    const line = set.candidates.find((c) => c.place.id === zhenets.id);
    expect(line).toMatchObject({ focus: true });
    expect(line!.place.estimate.landmark?.name).toBe("Женецький водоспад");
    const r = validateScenario(
      brief("waterfalls"),
      setOf([zhenets, small, lunch, place("museums", "Музей", 1100)]),
      scenario([item("p1", "09:00", 150, ["p4"]), item("p3", "12:00", 75), item("p2", "14:00", 150)]),
    );
    expect(r.errors.join()).not.toMatch(/той самий маршрут/);
  });
});

describe("сбои, запасная модель, деньги", () => {
  const set = setOf([probii, lunch, chan]);
  const good = scenario([item("p1", "10:00", 45, ["p3"]), item("p2", "12:00", 75), item("p3", "15:00", 120)]);
  const res = (o: unknown, over: Record<string, unknown> = {}) => ({
    stop_reason: "end_turn",
    model: "claude-opus-5-5",
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }],
    ...over,
  });

  it.each([
    ["max_tokens", res("{", { stop_reason: "max_tokens" }), /max_tokens/],
    [
      "отказ",
      res("", { stop_reason: "refusal", stop_details: { category: "bio" }, content: [] }),
      /refusal \(bio\)/,
    ],
    ["не JSON", res("не json"), /не JSON/],
  ])("критик: %s — раунд записан как error, черновик остаётся", async (_name, bad, reason) => {
    const create = vi.fn().mockResolvedValueOnce(res(good)).mockResolvedValueOnce(bad);
    const usage = emptyUsage();
    const r = await generateOne(api(create), brief("waterfalls"), set, usage, {
      retries: 0,
      criticRounds: 2,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(r.draft).not.toBeNull();
    expect(r.critic).toEqual([
      { round: 1, verdict: "error", issues: [expect.stringMatching(reason)], accepted: false },
    ]);
    expect(usage.maxTokensCritic).toBe(_name === "max_tokens" ? 1 : 0);
    expect(usage.maxTokensGen).toBe(0);
  });

  it("генерация: max_tokens считается отдельно, повторы — в сумме", async () => {
    const create = vi.fn().mockResolvedValue(res("{", { stop_reason: "max_tokens" }));
    const usage = emptyUsage();
    const r = await generateOne(api(create), brief("waterfalls"), set, usage, { retries: 1 });
    expect(r.draft).toBeNull();
    expect(usage).toMatchObject({ maxTokensGen: 2, maxTokensCritic: 0, requests: 2, input: 20, output: 20 });
    expect(usage.costUsd).toBeCloseTo((20 * 4 + 20 * 20) / 1e6, 9);
  });

  it("запасная модель: попытки из usage.iterations, каждая по своей цене, фактическая модель сохранена", async () => {
    const create = vi.fn().mockResolvedValueOnce(
      res(good, {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [
            {
              type: "message",
              model: "claude-opus-5-5",
              input_tokens: 1000,
              output_tokens: 200,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            {
              type: "fallback_message",
              model: "claude-opus-4-8",
              input_tokens: 1000,
              output_tokens: 500,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          ],
        },
        content: [
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
          { type: "text", text: JSON.stringify(good) },
        ],
      }),
    );
    const usage = emptyUsage();
    const r = await generateOne(api(create), brief("waterfalls"), set, usage, { retries: 0 });
    expect(r.draft).not.toBeNull();
    expect(r.model).toBe("claude-opus-4-8");
    expect(usage).toMatchObject({
      input: 2000,
      output: 700,
      requests: 1,
      fallbacks: 1,
      servedBy: { "claude-opus-4-8": 1 },
    });
    // Opus 5.5: 1000×4 + 200×20; Opus 4.8: 1000×5 + 500×25 — микродоллары.
    expect(usage.costUsd).toBeCloseTo(25_500 / 1e6, 9);
  });

  it("правка критика от запасной модели: модель итогового черновика — запасная", async () => {
    const better = scenario([
      item("p1", "09:30", 45, ["p3"]),
      item("p2", "12:00", 75),
      item("p3", "16:00", 120),
    ]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(res(good))
      .mockResolvedValueOnce(
        res({ verdict: "fix", issues: ["x"], revised: better }, { model: "claude-opus-5" }),
      );
    const r = await generateOne(api(create), brief("waterfalls"), set, emptyUsage(), {
      retries: 0,
      criticRounds: 1,
    });
    expect(r.model).toBe("claude-opus-5");
  });

  it("обрыв потока: попытка считается, вход из message_start идёт в сумму и отмечен как неполный", async () => {
    const usage = emptyUsage();
    const messages = {
      stream: () => ({
        finalMessage: () => Promise.reject(new Error("connection lost")),
        currentMessage: { model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 1 } },
      }),
    } as unknown as MessagesApi;
    const r = await generateOne(messages, brief("waterfalls"), set, usage, { retries: 0 });
    expect(r.errors[0]).toMatch(/connection lost/);
    expect(usage).toMatchObject({ requests: 0, failedRequests: 1, interrupted: 1, input: 1000 });
  });

  it("текст ответа: продолжение после отказа — склейка; новый ответ — текст после блока fallback", () => {
    const fb = {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
    };
    const text = (t: string) => ({ type: "text", text: t });
    type Blocks = Parameters<typeof answerText>[0];
    expect(answerText([text('{"a":'), fb, text("1}")] as unknown as Blocks)).toBe('{"a":1}');
    expect(answerText([text('{"a":'), fb, text('{"b":2}')] as unknown as Blocks)).toBe('{"b":2}');
    expect(answerText([fb, text('{"b":2}')] as unknown as Blocks)).toBe('{"b":2}');
    expect(answerText([text("x"), text("y")] as unknown as Blocks)).toBe("xy");
  });

  it("настоящий SDK на подменённом fetch: поток, beta-заголовок, finalMessage, отказ посреди вывода", async () => {
    const json = JSON.stringify(good);
    const cut = Math.floor(json.length / 2);
    const events = [
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: json.slice(0, cut) } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-4-8" },
        },
      },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: json.slice(cut) } },
      { type: "content_block_stop", index: 2 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 300 },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1000, output_tokens: 500 },
          ],
        },
      },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
    const fakeFetch = vi.fn((_url: unknown, init?: RequestInit) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    });
    const client = new Anthropic({ apiKey: "test", fetch: fakeFetch as typeof fetch, maxRetries: 0 });
    const usage = emptyUsage();
    const r = await generateOne(client.beta.messages, brief("waterfalls"), set, usage, { retries: 0 });
    expect(r.errors).toEqual([]);
    expect(r.draft).not.toBeNull();
    expect(r.model).toBe("claude-opus-4-8");
    expect(usage).toMatchObject({ input: 2000, output: 800, requests: 1, fallbacks: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({
      stream: true,
      max_tokens: GEN_MAX_TOKENS,
      model: "claude-opus-5-5",
      fallbacks: "default",
    });
    expect(requests[0]!.body.betas).toBeUndefined();
    expect(requests[0]!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("настоящий SDK: max_tokens с обрезанным JSON не роняет finalMessage, токены и причина видны", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"title_uk":"обр' } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 64000 },
      },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const client = new Anthropic({
      apiKey: "test",
      maxRetries: 0,
      fetch: (() =>
        Promise.resolve(
          new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
        )) as typeof fetch,
    });
    const usage = emptyUsage();
    const r = await generateOne(client.beta.messages, brief("waterfalls"), set, usage, { retries: 0 });
    expect(r.errors[0]).toMatch(/max_tokens/);
    expect(usage).toMatchObject({ maxTokensGen: 1, output: 64000, failedRequests: 0 });
  });
});

describe("журнал и прогон", () => {
  const usageOf = (costUsd: number): Usage => ({ ...emptyUsage(), costUsd });
  const draftOf = (code: string) => ({ code, items: [] }) as unknown as ScenarioDraft;
  const rec = (code: string, over: Partial<GenRecord> = {}): GenRecord => ({
    code,
    region: "r",
    status: "ok",
    draft: draftOf(code),
    errors: [],
    fixes: [],
    attempts: 1,
    critic: [],
    model: "claude-opus-5-5",
    usage: usageOf(1),
    at: "2026-11-04T00:00:00.000Z",
    ...over,
  });
  const order = (code: string): Order => ({ brief: brief("waterfalls", { code }), set: setOf([probii]) });
  const outcome = (code: string, over: Partial<GenOutcome> = {}): GenOutcome => ({
    code,
    draft: draftOf(code),
    errors: [],
    fixes: [],
    attempts: 1,
    critic: [],
    model: "claude-opus-5-5",
    ...over,
  });
  const run = (over: Partial<Parameters<typeof runOrders>[0]>) =>
    runOrders({
      orders: [],
      region: "r",
      concurrency: 1,
      maxUsd: null,
      spentBefore: 0,
      generate: () => Promise.reject(new Error("не задан")),
      append: () => Promise.resolve(),
      log: () => undefined,
      ...over,
    });

  it("runPaths: журнал и отчёт из --out", () => {
    expect(runPaths("a/run.json")).toEqual({ journal: "a/run.jsonl", report: "a/run.json" });
    expect(runPaths("a/run.jsonl")).toEqual({ journal: "a/run.jsonl", report: "a/run.json" });
    expect(runPaths("run")).toEqual({ journal: "run.jsonl", report: "run" });
  });

  it("запись сразу на диск; оборванная строка пропускается, следующая с новой строки; повторный код заменяет", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scenarios-journal-"));
    const file = path.join(dir, "sub", "run.jsonl");
    try {
      const append = await openJournal(file);
      await Promise.all([append(rec("a")), append(rec("b", { status: "rejected", draft: null }))]);
      expect((await readJournal(file)).records.map((r) => r.code)).toEqual(["a", "b"]);
      // Процесс убит посреди записи.
      await appendFile(file, '{"code":"c","draft":{"co');
      const after = await openJournal(file);
      await after(rec("b"));
      const { records, broken } = await readJournal(file);
      expect(broken).toBe(1);
      expect(records.map((r) => r.code)).toEqual(["a", "b", "b"]);
      expect(latestByCode(records).map((r) => [r.code, r.status])).toEqual([
        ["a", "ok"],
        ["b", "ok"],
      ]);
      // Деньги — за все строки, и за заменённую.
      expect(totalUsage(records).costUsd).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await readJournal(file)).toEqual({ records: [], broken: 0 });
  });

  it("готовые коды: упавшие повторяем, --skip-failed — нет", () => {
    const records = [rec("a"), rec("b", { status: "rejected", draft: null })];
    expect([...readyCodes(records, false)]).toEqual(["a"]);
    expect([...readyCodes(records, true)]).toEqual(["a", "b"]);
  });

  it("--from-file: итоговый файл и журнал JSONL", () => {
    expect(parseScenariosFile(JSON.stringify({ model: "x", scenarios: [draftOf("a")] }, null, 2))).toEqual({
      scenarios: [draftOf("a")],
      broken: 0,
    });
    expect(parseScenariosFile(JSON.stringify({ model: "x" }))).toEqual({ scenarios: [], broken: 1 });
    const jsonl = [
      JSON.stringify(rec("a", { draft: null, status: "rejected" })),
      JSON.stringify(rec("b")),
      JSON.stringify(rec("a")),
      '{"code":"c","dr',
      "",
    ].join("\n");
    const parsed = parseScenariosFile(jsonl);
    expect(parsed.broken).toBe(1);
    expect(parsed.scenarios).toEqual([draftOf("a"), draftOf("b")]);
    // Журнал из одной строки — тоже журнал.
    expect(parseScenariosFile(JSON.stringify(rec("z"))).scenarios).toEqual([draftOf("z")]);
  });

  it("лимит: новые заказы не берутся, идущие дорабатывают; потраченное и остаток в итоге", async () => {
    const appended: string[] = [];
    const started: string[] = [];
    const result = await run({
      orders: ["a", "b", "c", "d", "e"].map(order),
      concurrency: 2,
      maxUsd: 3,
      spentBefore: 1,
      append: (r) => {
        appended.push(r.code);
        return Promise.resolve();
      },
      generate: async ({ brief: b }, usage) => {
        started.push(b.code);
        await new Promise((r) => setTimeout(r, 5));
        usage.costUsd += 1;
        usage.requests++;
        await new Promise((r) => setTimeout(r, 5));
        usage.costUsd += 0.5; // критик того же заказа — уже после порога
        return outcome(b.code);
      },
    });
    expect(result.stoppedBy).toBe("budget");
    expect(started).toEqual(["a", "b"]);
    expect(appended.sort()).toEqual(["a", "b"]);
    expect(result.notStarted).toEqual(["c", "d", "e"]);
    expect(result.usage.costUsd).toBe(3);
    expect(result.usage.requests).toBe(2);
  });

  it("лимит уже исчерпан по журналу — ни одного запроса", async () => {
    const generate = vi.fn();
    const result = await run({ orders: [order("a")], maxUsd: 2, spentBefore: 2, generate });
    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stoppedBy: "budget", notStarted: ["a"], records: [] });
  });

  it("исключение заказа записывается с потраченным и не рушит пул", async () => {
    const appended: GenRecord[] = [];
    const result = await run({
      orders: ["a", "b", "c"].map(order),
      concurrency: 2,
      append: (r) => {
        appended.push(r);
        return Promise.resolve();
      },
      generate: ({ brief: b }, usage) => {
        usage.costUsd += 0.25;
        return b.code === "a" ? Promise.reject(new Error("сбой")) : Promise.resolve(outcome(b.code));
      },
    });
    expect(result.records).toHaveLength(3);
    expect(result.stoppedBy).toBeNull();
    const failed = appended.find((r) => r.code === "a")!;
    expect(failed).toMatchObject({ status: "error", draft: null, errors: ["сбой"] });
    expect(failed.usage.costUsd).toBe(0.25);
  });

  it("журнал не пишется — новые заказы не берутся, готовое остаётся в итоге", async () => {
    const log = vi.fn();
    const result = await run({
      orders: ["a", "b"].map(order),
      log,
      append: () => Promise.reject(new Error("диск заполнен")),
      generate: ({ brief: b }) => Promise.resolve(outcome(b.code)),
    });
    expect(result).toMatchObject({ stoppedBy: "journal", notStarted: ["b"] });
    expect(result.records.map((r) => r.code)).toEqual(["a"]);
    expect(log.mock.calls.flat().join()).toMatch(/диск заполнен/);
  });

  it("итоги: средняя цена, сбои критика, фактические модели", () => {
    const s = summarize([
      rec("a", {
        usage: usageOf(2),
        critic: [{ round: 1, verdict: "error", issues: ["x"], accepted: false }],
      }),
      rec("b", {
        usage: usageOf(1),
        model: "claude-opus-4-8",
        critic: [{ round: 1, verdict: "fix", issues: ["x"], accepted: true }],
      }),
      rec("c", { usage: usageOf(1), status: "rejected", draft: null, model: null }),
    ]);
    expect(s).toMatchObject({
      ok: 2,
      failed: 1,
      usdPerScenario: 2,
      criticErrors: 1,
      criticFixes: 1,
      models: { "claude-opus-5-5": 1, "claude-opus-4-8": 1 },
    });
    expect(summarize([]).usdPerScenario).toBeNull();
  });

  it("выбор заказов: готовые из журнала входят в --count, не генерируются повторно", () => {
    const catalog: GenCatalog = {
      regionId: "r",
      timezone: "Europe/Kyiv",
      places: [probii, lunch, chan, place("cafes", "Кава", 300), place("nature", "Водоспад Гук", 700)],
      localities: [{ code: "yaremche", name: "Яремче", location: CENTER }],
      existingCodes: new Set(["in-db"]),
    };
    const briefs = ["done", "in-db", "x", "y", "z"].map((code) => brief("waterfalls", { code }));
    const args = { count: 3, themes: new Set<ThemeCode>(), areas: new Set<string>() };
    const r = chooseOrders(briefs, catalog, args, new Set(["done"]));
    expect(r.resumed).toBe(1);
    expect(r.chosen.map((c) => c.brief.code)).toEqual(["x", "y"]);
    expect(r.skipped).toEqual([{ code: "in-db", reason: "уже есть в БД" }]);
  });

  it("оценка без запросов: нижняя граница и ориентир с критиком различаются и подписаны числом запросов", () => {
    const orders = [order("a"), order("b")];
    const e = planEstimate(orders, 2);
    expect(e.lowerBound.requests).toBe(2);
    expect(e.lowerBound.output).toBe(1400);
    expect(e.guess.requests).toBe(6);
    expect(e.guess.costUsd).toBeGreaterThan(e.lowerBound.costUsd * 5);
  });

  it("запись в БД: ошибка одного сценария не прерывает остальные", async () => {
    const done: string[] = [];
    const failed: string[] = [];
    await eachIsolated(
      ["a", "b", "c"],
      (x) => {
        if (x === "b") return Promise.reject(new Error("constraint"));
        done.push(x);
        return Promise.resolve();
      },
      (x) => failed.push(x),
    );
    expect(done).toEqual(["a", "c"]);
    expect(failed).toEqual(["b"]);
  });

  it("цены: Opus 5.5 — чтение кэша $0,20; запасная и незнакомая модель — по старшей цене", () => {
    expect(priceOf("claude-opus-5-5")).toMatchObject({ input: 4, cacheRead: 0.2, output: 20 });
    expect(priceOf("claude-opus-4-8")).toMatchObject({ input: 5, cacheRead: 0.5, output: 25 });
    expect(priceOf("claude-opus-5")).toEqual(priceOf("claude-opus-4-8"));
    expect(usd({ costUsd: 1.234 })).toBe(1.23);
    expect(requestParams(brief("waterfalls"), setOf([probii])).max_tokens).toBe(GEN_MAX_TOKENS);
  });
});
