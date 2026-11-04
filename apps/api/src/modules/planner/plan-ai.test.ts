// Unit: живой план через Claude (флаг planner.ai) — заказ из параметров туриста, кандидаты только из каталога,
// разнообразие (seed), проверка программой, повтор с ошибками, откат, пределы и учёт стоимости. Claude подменён.
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { LonLat } from "../../db/index.js";
import { genPlace, type GenCatalog, type GenPlace } from "../../scenarios-gen/catalog.js";
import type { GenParams } from "../../scenarios-gen/prompt.js";
import {
  accentOf,
  draftToPlanItems,
  generateLivePlan,
  PlanAiCallError,
  planBrief,
  planCandidates,
  planParams,
  PLANNER_AI_DEADLINE_MS,
  PLANNER_AI_EFFORT,
  PLANNER_AI_MIN_ATTEMPT_MS,
  PLANNER_AI_TIMEOUT_MS,
  PLANNER_AI_MODEL,
  PLANNER_AI_SYSTEM,
  type PlanAiMessages,
  type PlanAiParams,
} from "./plan-ai.js";
import { PlannerAi } from "./plan-ai.service.js";

const CENTER: LonLat = { lon: 24.55, lat: 48.45 };
const east = (m: number): LonLat => ({ lon: CENTER.lon + m / 73_800, lat: CENTER.lat });
const OPEN = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "08:00", closesAt: "22:00" }));
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
    rating: 4.6,
    ratingCount: 120,
    typeLabel: null,
    priceLevel: null,
    summary: null,
    weekly: [],
    ...over,
  });

const probii = place("nature", "Водоспад Пробій", 300);
const museum = place("museums", "Музей Гуцульщини", 600, { weekly: OPEN });
const kolyba = place("restaurants", "Колиба Гражда", 900, { weekly: OPEN });
const chan = place("chany", "Чани над річкою", 1200);
const cafe = place("cafes", "Кав'ярня Ранок", 400, { weekly: OPEN });
const hoverla = place("nature", "Гора Говерла", 1500);
/** Много мест темы: выборка с seed — не весь каталог. */
const filler = Array.from({ length: 70 }, (_, i) => place("sights", `Пам'ятка ${i + 1}`, 200 + i * 40));

const catalog: GenCatalog = {
  regionId: "r",
  timezone: "Europe/Kyiv",
  places: [probii, museum, kolyba, chan, cafe, hoverla, place("cafes", "Кафе Друге", 1000), ...filler],
  localities: [{ code: "yaremche", name: "Яремче", location: CENTER }],
  existingCodes: new Set(),
};

const params = (over: Partial<PlanAiParams> = {}): PlanAiParams => ({
  days: 1,
  children: 1,
  withCar: true,
  season: "summer",
  center: CENTER,
  centerName: "Яремче",
  interests: ["waterfalls"],
  avoid: [],
  noMountainDays: new Set(),
  seed: 7,
  ...over,
});

const textOf = (p: GenParams) => {
  const c = p.messages[0]!.content;
  return typeof c === "string" ? c : (c ?? []).map((x) => ("text" in x ? x.text : "")).join("\n");
};
/** Ссылка кандидата по названию из промпта («p3 | Колиба Гражда | …»). */
const refOf = (p: GenParams, name: string) => {
  const line = textOf(p)
    .split("\n")
    .find((l) => l.includes(`| ${name} |`));
  if (!line) throw new Error(`нет кандидата ${name}`);
  return line.split(" | ")[0]!;
};

const message = (json: unknown, over: Partial<Anthropic.Beta.Messages.BetaMessage> = {}) =>
  ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: PLANNER_AI_MODEL,
    content: [{ type: "text", text: JSON.stringify(json), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 3000,
      output_tokens: 1500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
    },
    ...over,
  }) as unknown as Anthropic.Beta.Messages.BetaMessage;

/** Правильный ответ модели для каталога выше (ссылки — из промпта). */
const goodPlan = (p: GenParams) => ({
  title_uk: "Водоспад і чани",
  title_en: "Waterfall and hot tubs",
  description_uk: "Неспішний день біля Пробою.",
  tags: ["waterfalls"],
  days: [
    {
      day: 1,
      items: [
        {
          ref: refOf(p, "Водоспад Пробій"),
          time: "10:00",
          minutes: 90,
          note_uk: "Зручне взуття.",
          alternatives: [refOf(p, "Музей Гуцульщини")],
        },
        { ref: refOf(p, "Колиба Гражда"), time: "12:30", minutes: 75, note_uk: "Банош.", alternatives: [] },
        {
          ref: refOf(p, "Чани над річкою"),
          time: "15:00",
          minutes: 120,
          note_uk: "Бронюйте.",
          alternatives: [],
        },
      ],
    },
  ],
});

const mock = (...answers: ((p: GenParams) => unknown)[]) => {
  const calls: GenParams[] = [];
  const create = vi.fn((p: GenParams) => {
    calls.push(p);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    const out = a(p);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(message(out));
  });
  return { messages: { create } as unknown as PlanAiMessages, create, calls };
};

describe("живой план: запрос к Claude", () => {
  it("модель, effort low, структурированный ответ, кэш системного промпта, запасная модель при отказе", () => {
    const p = planParams("текст");
    expect(p).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: PLANNER_AI_EFFORT, format: { type: "json_schema" } },
      system: [{ type: "text", text: PLANNER_AI_SYSTEM, cache_control: { type: "ephemeral" } }],
      fallbacks: "default",
    });
    expect(PLANNER_AI_EFFORT).toBe("low");
    expect(p).not.toHaveProperty("temperature");
    // Постоянная часть одинакова в каждом запросе — кэшируется.
    expect(planParams("другий").system).toEqual(p.system);
  });

  it("заказ из параметров: днів, діти, пішки — радиус и аудитория; интересы — категории темы", () => {
    const b = planBrief(params({ days: 3, children: 2, withCar: false, interests: ["culture"] }));
    expect(b).toMatchObject({ days: 3, seasons: ["summer"], center: CENTER });
    expect(b.theme).toMatchObject({ kids: true, noCar: true, radius: 3_000 });
    expect(b.theme.focus).toEqual(expect.arrayContaining(["museums", "kids"]));
    expect(b.theme.ask).toContain("з дітьми (2)");
    expect(b.theme.ask).toContain("пішки");
    expect(b.theme.ask).toContain(accentOf(7));
  });
});

describe("живой план: генерация", () => {
  it("правильный ответ — план из мест каталога, одна попытка; части дня — по времени", async () => {
    const { messages, create } = mock(goodPlan);
    const r = await generateLivePlan(messages, catalog, params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.attempts).toBe(1);
    expect(r.draft.items.map((i) => i.placeId)).toEqual([probii.id, kolyba.id, chan.id]);
    expect(r.usage).toMatchObject({ requests: 1, input: 3000, cacheRead: 2000, output: 1500 });
    expect(r.usage.costUsd).toBeGreaterThan(0);
    let k = 0;
    const items = draftToPlanItems(r.draft, () => `id-${++k}`);
    expect(items.map((i) => [i.slot, i.position])).toEqual([
      ["morning", 0],
      ["afternoon", 1],
      ["afternoon", 2],
    ]);
    expect(items[0]).toMatchObject({ dayNo: 1, alternatives: [museum.id], replacedPlaceId: null });
  });

  it("невалидный ответ → повтор с ошибками → правильный", async () => {
    const { messages, calls } = mock(
      (p) => ({
        ...goodPlan(p),
        days: [{ day: 1, items: [{ ...goodPlan(p).days[0]!.items[0]!, ref: "p999" }] }],
      }),
      goodPlan,
    );
    const r = await generateLivePlan(messages, catalog, params());
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(textOf(calls[1]!)).toContain("Попередня спроба не пройшла перевірку");
    expect(textOf(calls[1]!)).toContain("p999");
  });

  it("невалидно дважды — откат (ok: false, invalid), не больше двух запросов", async () => {
    const { messages, create } = mock(() => ({ title_uk: "Х", days: [] }));
    const r = await generateLivePlan(messages, catalog, params());
    expect(r).toMatchObject({ ok: false, reason: "invalid", attempts: 2 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("таймаут — без повтора (турист уже ждал); сбой API — повтор", async () => {
    const t = mock(() => new PlanAiCallError(true));
    expect(await generateLivePlan(t.messages, catalog, params())).toMatchObject({
      ok: false,
      reason: "timeout",
      attempts: 1,
    });
    const u = mock(() => new PlanAiCallError(false, 529), goodPlan);
    expect(await generateLivePlan(u.messages, catalog, params())).toMatchObject({ ok: true, attempts: 2 });
  });

  it("общий дедлайн: вторая попытка — с остатком бюджета; остаток меньше 15 с — сразу откат", async () => {
    const opts = (c: { mock: { calls: unknown[][] } }, i: number) =>
      c.mock.calls[i]![1] as { timeout: number; signal: AbortSignal };
    let now = 0;
    const slow = mock((p) => {
      now += 30_000;
      return { ...goodPlan(p), days: [] };
    });
    expect(await generateLivePlan(slow.messages, catalog, params(), { now: () => now })).toMatchObject({
      ok: false,
      attempts: 2,
    });
    expect(opts(slow.create, 0).timeout).toBe(PLANNER_AI_TIMEOUT_MS);
    // 55 с − 30 с первой попытки: вторая — не дольше 25 с, а не ещё 35.
    expect(opts(slow.create, 1).timeout).toBe(PLANNER_AI_DEADLINE_MS - 30_000);
    expect(opts(slow.create, 1).signal).toBeInstanceOf(AbortSignal);
    now = 0;
    const slower = mock((p) => {
      now += PLANNER_AI_DEADLINE_MS - PLANNER_AI_MIN_ATTEMPT_MS + 1;
      return { ...goodPlan(p), days: [] };
    });
    expect(await generateLivePlan(slower.messages, catalog, params(), { now: () => now })).toMatchObject({
      ok: false,
      attempts: 1,
    });
    expect(slower.create).toHaveBeenCalledTimes(1);
    // Обе попытки вместе — не дольше дедлайна.
    expect(PLANNER_AI_DEADLINE_MS).toBeLessThanOrEqual(55_000);
  });

  it("погода: горный поход в опасный день — ошибка и повтор; в промпте — предупреждение", async () => {
    const withHike = (p: GenParams) => {
      const g = goodPlan(p);
      g.days[0]!.items[0] = {
        ...g.days[0]!.items[0]!,
        ref: refOf(p, "Гора Говерла"),
        time: "08:00",
        minutes: 120,
      };
      return g;
    };
    const { messages, calls } = mock(withHike, goodPlan);
    const r = await generateLivePlan(messages, catalog, params({ days: 1, noMountainDays: new Set([1]) }));
    // Все дни опасны — горных маршрутов нет среди кандидатов вовсе: первый ответ не находит ссылку.
    expect(textOf(calls[0]!)).toContain("небезпечно для гір");
    expect(textOf(calls[0]!)).not.toContain("Гора Говерла");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("мало мест в каталоге — без запроса к Claude (no_candidates)", async () => {
    const { messages, create } = mock(goodPlan);
    const tiny = { ...catalog, places: [probii] };
    expect(await generateLivePlan(messages, tiny, params())).toMatchObject({
      ok: false,
      reason: "no_candidates",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("живой план: разнообразие", () => {
  it("два seed — разные выборки кандидатов; тот же seed — та же; места прошлых планов — с пометкой", () => {
    const ids = (seed: number) =>
      planCandidates(planBrief(params({ seed })), catalog, params({ seed })).candidates.map(
        (c) => c.place.id,
      );
    const a = ids(1);
    const b = ids(2);
    expect(a).toEqual(ids(1));
    expect(new Set(a)).not.toEqual(new Set(b));
    expect(a.length).toBeLessThan(catalog.places.length);
    // Место прошлого плана — со штрафом: ниже в выборке (или вне её), в промпте — «уже в 1 сценаріях».
    const all = { ...params(), seed: 3 };
    expect(
      planCandidates(planBrief(all), catalog, all).candidates.some((c) => c.place.id === probii.id),
    ).toBe(true);
    const set = planCandidates(planBrief(all), catalog, { ...all, avoid: [probii.id] });
    expect(set.candidates.every((c) => c.place.id !== probii.id || c.used === 1)).toBe(true);
  });

  it("акцент зависит от seed", () => {
    expect(new Set([0, 1, 2, 3, 4, 5].map(accentOf)).size).toBeGreaterThan(3);
  });
});

describe("PlannerAi: пределы, сессия, стоимость", () => {
  const region = { id: "0190f5c2-7d3e-7000-8000-00000000000a", timezone: "Europe/Kyiv" };
  const ai = (messages: PlanAiMessages | null, config = {}) => {
    const s = new PlannerAi({} as never, config, messages);
    vi.spyOn(s, "catalog").mockResolvedValue(catalog);
    // Постоянный seed: случайный менял выборку кандидатов, и тесты пределов изредка падали.
    s.seed = () => 7;
    return s;
  };
  const input = { ...params(), avoid: undefined } as Omit<PlanAiParams, "seed" | "avoid">;

  it("без ключа — выключен, Claude не вызывается", async () => {
    const s = ai(null);
    expect(s.enabled).toBe(false);
    expect(await s.generate("u", region, input)).toMatchObject({ ok: false });
  });

  it("предел пользователя — правиловый план без запроса; общий предел — тоже", async () => {
    const { messages, create } = mock(goodPlan);
    const s = ai(messages, { userDailyLimit: 1, dailyLimit: 2 });
    expect((await s.generate("u1", region, input)).ok).toBe(true);
    expect(await s.generate("u1", region, input)).toEqual({ ok: false, reason: "limit" });
    expect((await s.generate("u2", region, input)).ok).toBe(true);
    expect(await s.generate("u3", region, input)).toEqual({ ok: false, reason: "limit" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("«мало мест» — правиловый план без запроса и без списания предела", async () => {
    const { messages, create } = mock(goodPlan);
    const s = new PlannerAi({} as never, { userDailyLimit: 1 }, messages);
    s.seed = () => 7;
    const spy = vi.spyOn(s, "catalog").mockResolvedValue({ ...catalog, places: [probii] });
    expect(await s.generate("u", region, input)).toEqual({ ok: false, reason: "no_candidates" });
    expect(await s.generate("u", region, input)).toEqual({ ok: false, reason: "no_candidates" });
    spy.mockResolvedValue(catalog);
    expect((await s.generate("u", region, input)).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("длинная поездка — правиловый план (too_long)", async () => {
    const { messages, create } = mock(goodPlan);
    expect(await ai(messages).generate("u", region, { ...input, days: 9 })).toEqual({
      ok: false,
      reason: "too_long",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("следующий план того же туриста — «відмінний від попередніх» с местами прошлого, другой seed", async () => {
    const { messages, calls } = mock(goodPlan);
    const s = ai(messages);
    let seed = 0;
    s.seed = () => ++seed;
    await s.generate("u", region, input);
    await s.generate("u", region, input);
    expect(textOf(calls[0]!)).not.toContain("Відмінний від попередніх");
    expect(textOf(calls[1]!)).toContain("Відмінний від попередніх");
    expect(textOf(calls[1]!)).toContain("Водоспад Пробій");
    expect(textOf(calls[0]!)).toContain(accentOf(1));
    expect(textOf(calls[1]!)).toContain(accentOf(2));
    // Другой турист — без чужих мест.
    await s.generate("other", region, input);
    expect(textOf(calls[2]!)).not.toContain("Відмінний від попередніх");
  });

  it("стоимость — в лог (без id пользователя)", async () => {
    const { messages } = mock(goodPlan);
    const s = ai(messages);
    const log = vi.spyOn((s as unknown as { log: { log: (m: string) => void } }).log, "log");
    log.mockImplementation(() => undefined);
    await s.generate("secret-user", region, input);
    const line = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toMatch(/Planner AI: ok .*cost=\$/);
    expect(line).not.toContain("secret-user");
  });
});
