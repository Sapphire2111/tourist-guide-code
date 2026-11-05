// Unit (без БД и сети): удобства «Де жити» (places:amenities) — отбор текстов Google, проверка ответа модели
// (цитата есть в тексте, слово удобства, отрицание, «поруч», «смачна кухня»), задачи прогона, план тегов (ручные
// теги не трогаются, снимаются только свои теги reviews), запрос к модели с подменой клиента, аргументы.
import { describe, expect, it, vi } from "vitest";
import {
  AMENITY_CODES,
  AMENITY_TAG,
  AMENITY_TAG_DEFS,
  addApiUsage,
  checkFinding,
  negatedNear,
  emptyAmenitiesUsage,
  ExtractionParseError,
  inputHash,
  parseExtraction,
  planCost,
  relevantSources,
  requestParams,
  structuredAmenities,
  type AmenityCode,
  type RejectReason,
  type Source,
} from "./amenities.js";
import { AmenitiesArgsError, DEFAULT_MAX_USD, parseAmenitiesArgs } from "./args.js";
import {
  extractOne,
  parseAmenityJournal,
  planTasks,
  readyResults,
  resultsOf,
  runExtraction,
  type AmenityRecord,
  type CreateApi,
} from "./run.js";
import { planChanges, type LodgingPlace } from "./store.js";

const review = (text: string) => ({
  author: { name: "Гість", uri: null, photoUri: null },
  rating: 5,
  text,
  language: "uk",
  publishTime: null,
  relativeTime: null,
  uri: null,
});

const SOURCES: Source[] = [
  { label: "опис Google", text: "Садиба з критим басейном і сауною." },
  {
    label: "відгук 1",
    text: "Басейну немає, хоча на сайті був. Чан неподалік, у сусідів. Wi-Fi не працював.",
  },
  { label: "відгук 2", text: "Смачна кухня, сніданок включено. Їздили з собакою — без проблем!" },
];

function place(over: Partial<LodgingPlace> = {}): LodgingPlace {
  return {
    id: "p1",
    name: "Садиба",
    category: "sadyby",
    google: null,
    touched: false,
    tags: new Map(),
    appliedHash: null,
    ...over,
  };
}

describe("коды и теги", () => {
  it("каждое удобство — тег формата is_catalog_code, все теги описаны (uk/en)", () => {
    const defs = new Map(AMENITY_TAG_DEFS.map((t) => [t.code, t]));
    for (const c of AMENITY_CODES) {
      expect(AMENITY_TAG[c]).toMatch(/^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/);
      expect(defs.get(AMENITY_TAG[c])?.name.uk, c).toBeTruthy();
      expect(defs.get(AMENITY_TAG[c])?.name.en, c).toBeTruthy();
    }
  });

  it("структурированные удобства Google → удобства (без инвалидных и ресторанных)", () => {
    expect(
      structuredAmenities([
        "wheelchair_entrance",
        "good_for_children",
        "parking_paid",
        "parking_free",
        "breakfast",
        "dogs_allowed",
        "kids_menu",
      ]),
    ).toEqual(["breakfast", "parking", "pets", "kids"]);
    expect(structuredAmenities([])).toEqual([]);
  });
});

describe("relevantSources", () => {
  it("только тексты с ключевыми словами; пробелы схлопнуты; hits — найденные удобства", () => {
    const r = relevantSources({
      summary: "Затишна садиба в горах",
      reviews: [review("Гарний вид   з вікна."), review("Є чан і   сауна, діти були в захваті"), review("")],
    });
    expect(r.sources).toEqual([{ label: "відгук 2", text: "Є чан і сауна, діти були в захваті" }]);
    expect(r.hits).toEqual(["sauna", "hot_tub", "kids"]);
    expect(relevantSources(null)).toEqual({ sources: [], hits: [] });
  });

  it("границы слов для кириллицы: «чансон», «банк» и «нема» внутри слов — не удобства", () => {
    expect(relevantSources({ summary: "Грав чансон, поруч банкомат і банк", reviews: [] }).hits).toEqual([]);
    expect(relevantSources({ summary: "Були в бані, потім у чані", reviews: [] }).hits).toEqual([
      "sauna",
      "hot_tub",
    ]);
  });
});

describe("checkFinding / parseExtraction (проверка ответа модели)", () => {
  it("принимает дословную цитату с ключевым словом (регистр, пробелы, кавычки, «…» по краям — не важны)", () => {
    expect(checkFinding("pool", "з критим басейном", SOURCES)).toBeNull();
    expect(checkFinding("breakfast", "  СНІДАНОК   включено…", SOURCES)).toBeNull();
    expect(checkFinding("pets", "«Їздили з собакою — без проблем!»", SOURCES)).toBeNull();
  });

  it("отрицание — отброшено (басейну немає, Wi-Fi не працював)", () => {
    expect(checkFinding("pool", "Басейну немає", SOURCES)).toBe("negation");
    expect(checkFinding("wifi", "Wi-Fi не працював", SOURCES)).toBe("negation");
  });

  it("запрет и «без» рядом со словом удобства — отрицание; «без» не перед удобством — нет", () => {
    const src = (text: string): Source[] => [{ label: "відгук 1", text }];
    const cases: [AmenityCode, string, RejectReason | null][] = [
      ["pets", "з тваринами не можна", "negation"],
      ["pets", "собак не приймають", "negation"],
      ["pets", "Заборонено з собаками", "negation"],
      ["pets", "с животными нельзя", "negation"],
      ["pets", "тварин не допускають", "negation"],
      ["kitchen", "номери без кухні", "negation"],
      ["breakfast", "без сніданку", "negation"],
      ["breakfast", "без жодного сніданку", "negation"],
      ["breakfast", "сніданок без додаткової оплати", null],
      ["wifi", "Wi-Fi без проблем", null],
      ["parking", "паркування без обмежень", null],
      ["pets", "з собакою без проблем поселили", null],
      ["kids", "діти в захваті, дозволили гратися", null],
      ["parking", "без проблем з паркуванням", null],
      ["pets", "без проблем з собакою", null],
      ["pets", "без питань поселили з собакою", null],
      ["parking", "без жодних проблем з парковкою", null],
      ["parking", "без проблем, але без парковки", "negation"],
    ];
    for (const [code, text, want] of cases) expect(checkFinding(code, text, src(text)), text).toBe(want);
    expect(negatedNear("kitchen", "кухня є, без посуду")).toBe(false);
  });

  it("«поруч» / у сусідів — отброшено", () => {
    expect(checkFinding("hot_tub", "Чан неподалік, у сусідів", SOURCES)).toBe("nearby");
  });

  it("выдуманная цитата, цитата без слова удобства, ресторанная «кухня», неизвестный код — отброшены", () => {
    expect(checkFinding("pool", "Є великий підігрівний басейн", SOURCES)).toBe("not_in_source");
    expect(checkFinding("sauna", "Садиба з критим", SOURCES)).toBe("no_keyword");
    expect(checkFinding("kitchen", "Смачна кухня", SOURCES)).toBe("cuisine");
    expect(checkFinding("spa", "з критим басейном", SOURCES)).toBe("unknown_code");
    expect(checkFinding("pool", "  … ", SOURCES)).toBe("empty");
    expect(checkFinding("pool", "басейн ".repeat(60), SOURCES)).toBe("too_long");
  });

  it("parseExtraction: принятые по порядку кодов, повтор кода — duplicate, отброшенные с причиной", () => {
    const text = JSON.stringify({
      amenities: [
        { code: "sauna", evidence: "сауною" },
        { code: "pool", evidence: "з критим басейном" },
        { code: "pool", evidence: "Садиба з критим басейном" },
        { code: "pool", evidence: "Басейну немає" },
        { code: "hot_tub", evidence: "Чан неподалік" },
      ],
    });
    const r = parseExtraction(text, SOURCES);
    expect(r.accepted).toEqual([
      { code: "pool", evidence: "з критим басейном" },
      { code: "sauna", evidence: "сауною" },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate", "negation", "nearby"]);
  });

  it("неразборчивый ответ — ExtractionParseError", () => {
    expect(() => parseExtraction("не json", SOURCES)).toThrow(ExtractionParseError);
    expect(() => parseExtraction("{}", SOURCES)).toThrow(ExtractionParseError);
    expect(parseExtraction('{"amenities":[]}', SOURCES)).toEqual({ accepted: [], rejected: [] });
  });
});

describe("запрос и деньги", () => {
  it("запрос: модель Sonnet, схема JSON, системный промпт с кэшем, тексты с метками", () => {
    const p = requestParams("Садиба", SOURCES);
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(p.system)).toContain('"cache_control"');
    expect(JSON.stringify(p.messages)).toContain("[відгук 1] Басейну немає");
  });

  it("стоимость по ценам Sonnet ($2/$10, кэш ×1,25 / ×0,1); оценка --plan растёт с текстом", () => {
    const u = emptyAmenitiesUsage();
    addApiUsage(u, { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 });
    expect(u.costUsd).toBeCloseTo(2 + 1 + 0.2);
    expect(u.requests).toBe(1);
    const small = planCost([{ name: "a", sources: SOURCES.slice(0, 1) }]).costUsd;
    expect(planCost([{ name: "a", sources: SOURCES }]).costUsd).toBeGreaterThan(small);
  });

  it("хэш входа меняется вместе с текстами", () => {
    expect(inputHash(SOURCES)).toMatch(/^[0-9a-f]{32}$/);
    expect(inputHash(SOURCES)).not.toBe(inputHash(SOURCES.slice(1)));
  });
});

const record = (over: Partial<AmenityRecord>): AmenityRecord => ({
  placeId: "p1",
  name: "Садиба",
  hash: "h",
  status: "ok",
  accepted: [],
  rejected: [],
  error: null,
  model: "claude-sonnet-5-5",
  usage: { ...emptyAmenitiesUsage(), costUsd: 0.01, requests: 1 },
  at: "",
  ...over,
});

describe("журнал и задачи прогона", () => {
  it("журнал: битая строка пропускается и считается; готовы только ok по месту и хэшу", () => {
    const text = `${JSON.stringify(record({}))}\n{оборвано\n${JSON.stringify(record({ placeId: "p2", status: "error" }))}\n`;
    const j = parseAmenityJournal(text);
    expect(j.broken).toBe(1);
    expect([...readyResults(j.records).keys()]).toEqual(["p1|h"]);
  });

  it("planTasks: без ключевых слов — без модели; готово в журнале или аудите — без модели; лимит — только на новые", () => {
    const g = (t: string) => ({
      summary: null,
      reviews: [review(t)],
      amenities: ["good_for_children"] as const,
    });
    const places = [
      place({ id: "a", google: { ...g("Гарний вид"), amenities: ["good_for_children"] } }),
      place({ id: "b", google: { ...g("Є басейн"), amenities: [] } }),
      place({ id: "c", google: { ...g("Є сауна"), amenities: [] } }),
      place({ id: "d", google: { ...g("Є чан"), amenities: [] } }),
      place({ id: "e", google: { ...g("Є Wi-Fi"), amenities: [] } }),
    ];
    const hashC = inputHash(relevantSources(places[2]!.google).sources);
    const hashD = inputHash(relevantSources(places[3]!.google).sources);
    places[3]!.appliedHash = hashD;
    const ready = readyResults([record({ placeId: "c", hash: hashC })]);
    const tasks = planTasks(places, ready, { limit: 1 });
    expect(tasks.map((t) => [t.place.id, t.ai])).toEqual([
      ["a", "no_keywords"],
      ["b", "ask"],
      ["c", "journal"],
      ["d", "applied"],
      ["e", "limit"],
    ]);
    expect(tasks[0]!.structured).toEqual(["kids"]);
    expect(planTasks(places, ready, { limit: null, only: new Set(["e"]) }).map((t) => t.ai)).toEqual(["ask"]);
  });

  it("resultsOf: находки из журнала/ответа; без текстов — пустой список (снять старые reviews); не спрашивали — null", () => {
    const places = [
      place({ id: "a", google: { summary: null, reviews: [], amenities: ["dogs_allowed"] } }),
      place({ id: "b", google: { summary: "Є басейн", reviews: [], amenities: [] } }),
      place({ id: "c", google: { summary: "Є сауна", reviews: [], amenities: [] } }),
    ];
    const tasks = planTasks(places, new Map(), { limit: 1 });
    const fresh = [
      record({ placeId: "b", hash: tasks[1]!.hash!, accepted: [{ code: "pool", evidence: "Є басейн" }] }),
    ];
    expect(resultsOf(tasks, fresh)).toEqual([
      { placeId: "a", structured: ["pets"], reviews: [], hash: null },
      {
        placeId: "b",
        structured: [],
        reviews: [{ code: "pool", evidence: "Є басейн" }],
        hash: tasks[1]!.hash,
      },
      { placeId: "c", structured: [], reviews: null, hash: null },
    ]);
  });
});

describe("extractOne / runExtraction (клиент подменён)", () => {
  const task = () =>
    planTasks(
      [place({ google: { summary: "Садиба з критим басейном", reviews: [], amenities: [] } })],
      new Map(),
      {
        limit: null,
      },
    )[0]!;
  const reply = (text: string, stop = "end_turn") =>
    ({
      model: "claude-sonnet-5-5",
      stop_reason: stop,
      content: [{ type: "text", text }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    }) as never;

  it("ответ проверяется программой; деньги учтены; refusal и мусор — ошибка с учтёнными деньгами", async () => {
    const ok = await extractOne(
      {
        create: vi.fn(() =>
          Promise.resolve(
            reply(
              '{"amenities":[{"code":"pool","evidence":"з критим басейном"},{"code":"sauna","evidence":"сауна є"}]}',
            ),
          ),
        ),
      } as unknown as CreateApi,
      task(),
    );
    expect(ok.status).toBe("ok");
    expect(ok.accepted).toEqual([{ code: "pool", evidence: "з критим басейном" }]);
    expect(ok.rejected).toEqual([{ code: "sauna", evidence: "сауна є", reason: "not_in_source" }]);
    expect(ok.usage.costUsd).toBeCloseTo(0.003);

    const refused = await extractOne(
      { create: vi.fn(() => Promise.resolve(reply("", "refusal"))) } as unknown as CreateApi,
      task(),
    );
    expect(refused).toMatchObject({ status: "error", error: "stop_reason=refusal" });
    expect(refused.usage.requests).toBe(1);
    const junk = await extractOne(
      { create: vi.fn(() => Promise.resolve(reply("oops"))) } as unknown as CreateApi,
      task(),
    );
    expect(junk.status).toBe("error");
    const failed = await extractOne(
      { create: vi.fn(() => Promise.reject(new Error("HTTP 500"))) } as unknown as CreateApi,
      task(),
    );
    expect(failed).toMatchObject({ status: "error", error: "HTTP 500" });
  });

  it("лимит расходов на весь журнал: после порога новые запросы не делаются; каждый ответ — в журнал", async () => {
    const tasks = planTasks(
      ["a", "b", "c"].map((id) =>
        place({ id, google: { summary: `Є басейн ${id}`, reviews: [], amenities: [] } }),
      ),
      new Map(),
      { limit: null },
    );
    const create = vi.fn(() => Promise.resolve(reply('{"amenities":[]}')));
    const append = vi.fn(() => Promise.resolve());
    const run = await runExtraction({
      tasks,
      api: { create } as unknown as CreateApi,
      concurrency: 1,
      maxUsd: 0.005,
      spentBefore: 0.001,
      append,
      log: () => {},
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ stoppedBy: "budget", notStarted: 1 });
  });
});

describe("planChanges (план тегов)", () => {
  it("добавляет import и reviews; ручные теги места — пропуск; источник reviews → import при подтверждении Google", () => {
    const places = [
      place({ id: "a", tags: new Map([["pool", "reviews"]]) }),
      place({ id: "b", touched: true }),
      place({ id: "c", tags: new Map([["parking", "manual"]]) }),
    ];
    const { changes, skippedTouched } = planChanges(places, [
      {
        placeId: "a",
        structured: ["pool", "kids"],
        reviews: [{ code: "sauna", evidence: "сауна" }],
        hash: "h1",
      },
      { placeId: "b", structured: ["kids"], reviews: [], hash: null },
      { placeId: "c", structured: ["parking"], reviews: null, hash: null },
    ]);
    expect(skippedTouched).toEqual(["b"]);
    expect(changes).toEqual([
      {
        placeId: "a",
        name: "Садиба",
        add: [
          { code: "sauna", source: "reviews", evidence: "сауна" },
          { code: "kids", source: "import" },
        ],
        upgrade: ["pool"],
        remove: [],
        hash: "h1",
        evidence: { sauna: "сауна" },
      },
    ]);
  });

  it("снимает только свои теги reviews, если новое извлечение их не подтвердило; ручные и import — никогда", () => {
    const tags = new Map([
      ["pool", "reviews"],
      ["sauna", "manual"],
      ["kids", "import"],
    ] as const);
    const p = place({ tags: new Map(tags) });
    expect(
      planChanges([p], [{ placeId: "p1", structured: [], reviews: [], hash: "h" }]).changes[0],
    ).toMatchObject({
      add: [],
      remove: ["pool"],
    });
    // Не спрашивали (лимит, сбой) — теги reviews не трогаются.
    expect(planChanges([p], [{ placeId: "p1", structured: [], reviews: null, hash: null }]).changes).toEqual(
      [],
    );
  });

  it("без изменений тегов места нет в плане (и аудита нет) — и при новом хэше; хэш — только в аудит изменения", () => {
    const p = place({ appliedHash: "h", tags: new Map([["pool", "reviews"]]) });
    const r = {
      placeId: "p1",
      structured: [],
      reviews: [{ code: "pool" as const, evidence: "басейн" }],
      hash: "h",
    };
    expect(planChanges([p], [r]).changes).toEqual([]);
    expect(planChanges([{ ...p, appliedHash: null }], [r]).changes).toEqual([]);
    expect(planChanges([{ ...p, tags: new Map() }], [r]).changes[0]).toMatchObject({
      add: [{ code: "pool", source: "reviews" }],
      hash: null,
    });
    expect(planChanges([{ ...p, appliedHash: null, tags: new Map() }], [r]).changes[0]?.hash).toBe("h");
  });
});

describe("parseAmenitiesArgs", () => {
  it("по умолчанию без записи, лимит $3; --out обязателен (кроме --plan)", () => {
    expect(parseAmenitiesArgs(["--out", "a.jsonl"])).toMatchObject({
      write: false,
      plan: false,
      maxUsd: DEFAULT_MAX_USD,
      limit: null,
      region: "test-region",
    });
    expect(DEFAULT_MAX_USD).toBe(3);
    expect(() => parseAmenitiesArgs([])).toThrow(AmenitiesArgsError);
    expect(parseAmenitiesArgs(["--plan"]).plan).toBe(true);
  });

  it("--write, --limit, --max-usd, --only; ошибки значений", () => {
    const a = parseAmenitiesArgs([
      "--",
      "--out",
      "x",
      "--write",
      "--limit",
      "10",
      "--max-usd",
      "1.5",
      "--only",
      "A,b",
    ]);
    expect(a).toMatchObject({ write: true, limit: 10, maxUsd: 1.5 });
    expect([...a.only]).toEqual(["a", "b"]);
    expect(() => parseAmenitiesArgs(["--out", "x", "--max-usd", "0"])).toThrow(AmenitiesArgsError);
    expect(() => parseAmenitiesArgs(["--out", "x", "--limit", "-1"])).toThrow(AmenitiesArgsError);
    expect(() => parseAmenitiesArgs(["--plan", "--write"])).toThrow(AmenitiesArgsError);
    expect(() => parseAmenitiesArgs(["--out", "x", "--bogus"])).toThrow(AmenitiesArgsError);
  });
});
