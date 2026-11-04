// Мок api блока 5 для E2E Mini App: «Про заклад» (HostModule), сервисные заявки, режим персонала,
// сценарии и «Мій план». Состояние — на страницу (apiMockState), переходы статусов и 409 — как на сервере.
import type { Page, Route } from "@playwright/test";
import { HOTEL_PLACE, REGION_ID } from "./api-mock.js";

export const SCENARIO_ID = "00000000-0000-4000-8000-000000000701";
const PLAN_ID = "00000000-0000-4000-8000-000000000801";
const CAFE = "00000000-0000-4000-8000-000000000202";
const PIZZA = "00000000-0000-4000-8000-000000000203";

export type ServiceRequestMock = {
  id: string;
  serviceCode: string;
  roomLabel: string;
  status: string;
  statusReason: string | null;
  comment: string | null;
  outsideHours: boolean;
  idempotencyKey: string;
};

export type Block5State = {
  /** Пользователь — персонал отеля (GET /staff/places не пуст). */
  staff: boolean;
  /** Сейчас часы приёма заявок. */
  acceptingNow: boolean;
  serviceRequests: ServiceRequestMock[];
  /** Сохранённые планы (UserPlanDto). */
  plans: PlanMock[];
  /** Флаг planner.ai: свой план «составляет Claude» (варианты по кругу), «Інший варіант» — следующий. */
  aiPlanner: boolean;
  /** Сколько планов «составил Claude» (создание и «Інший варіант»). */
  aiCalls: number;
};

type PlaceMock = {
  id: string;
  categoryId: string;
  name: { uk: string };
  address: null;
  location: { lon: number; lat: number };
};
type ItemMock = {
  id: string;
  position: number;
  timeHint: string | null;
  durationMin: number | null;
  note: { uk: string } | null;
  place: PlaceMock;
  available: boolean;
  alternatives: PlaceMock[];
  distanceFromPreviousMeters: number | null;
  replaced?: boolean;
  slot?: string;
};
type TripMock = { adults: number; children: number; withCar: boolean; days: number; base: unknown };
type PlanMock = {
  id: string;
  trip: TripMock;
  plan: { dayNo: number; items: ItemMock[] }[];
  options: unknown[];
} & Record<string, unknown>;

/** Каталог для вариантов «Мій план» (как будто из Google Maps): часть дня, вид, причина, расстояние от базы. */
type OptionSeed = {
  id: string;
  name: string;
  slot: string;
  kind: string;
  reason: string;
  m: number;
  bar?: boolean;
};
const OPTION_SEEDS: readonly OptionSeed[] = [
  {
    id: "00000000-0000-4000-8000-000000000a01",
    name: "Кав'ярня «Смерека»",
    slot: "morning",
    kind: "cafes",
    reason: "breakfast",
    m: 400,
  },
  {
    id: "00000000-0000-4000-8000-000000000a02",
    name: "Водоспад Пробій",
    slot: "morning",
    kind: "waterfall",
    reason: "walk",
    m: 1200,
  },
  {
    id: "00000000-0000-4000-8000-000000000a03",
    name: "Музей «Гуцульщина»",
    slot: "morning",
    kind: "museums",
    reason: "culture",
    m: 900,
  },
  {
    id: "00000000-0000-4000-8000-000000000a04",
    name: "Колиба «Ватра»",
    slot: "afternoon",
    kind: "kolyby",
    reason: "lunch",
    m: 700,
  },
  {
    id: "00000000-0000-4000-8000-000000000a05",
    name: "Гора Маковиця",
    slot: "afternoon",
    kind: "nature",
    reason: "walk",
    m: 6500,
  },
  {
    id: "00000000-0000-4000-8000-000000000a06",
    name: "Ринок сувенірів",
    slot: "afternoon",
    kind: "markets",
    reason: "shopping",
    m: 1100,
  },
  {
    id: "00000000-0000-4000-8000-000000000a07",
    name: "Ресторан «Гуцульщина»",
    slot: "evening",
    kind: "restaurants",
    reason: "dinner",
    m: 800,
  },
  {
    id: "00000000-0000-4000-8000-000000000a08",
    name: "Чани «Купіль»",
    slot: "evening",
    kind: "chany",
    reason: "relax",
    m: 4200,
  },
  {
    id: "00000000-0000-4000-8000-000000000a09",
    name: "Бар «Нічний Прут»",
    slot: "evening",
    kind: "bar",
    reason: "evening_out",
    m: 300,
    bar: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000a10",
    name: "Музей писанки",
    slot: "rain",
    kind: "museums",
    reason: "indoor",
    m: 1000,
  },
  {
    id: "00000000-0000-4000-8000-000000000a11",
    name: "SPA «Ранок»",
    slot: "rain",
    kind: "spa",
    reason: "indoor",
    m: 2600,
  },
  {
    id: "00000000-0000-4000-8000-000000000a12",
    name: "Кафе «Під дахом»",
    slot: "rain",
    kind: "cafes",
    reason: "indoor",
    m: 500,
  },
];
const optionPlace = (o: OptionSeed): PlaceMock & { categoryName: { uk: string } } => ({
  ...place(o.id, o.name, 48.45, 24.56),
  categoryName: { uk: o.kind },
});

/** Варианты, как на сервере: без выбранных, с детьми — без бара, без авто — далеко с «потрібен транспорт». */
function planOptions(trip: TripMock, chosen: ReadonlySet<string>) {
  return Array.from({ length: trip.days }, (_, k) => ({
    dayNo: k + 1,
    slots: ["morning", "afternoon", "evening", "rain"].map((slot) => ({
      slot,
      options: OPTION_SEEDS.filter(
        (o) => o.slot === slot && !chosen.has(o.id) && !(trip.children > 0 && o.bar),
      ).map((o) => {
        const walk = o.m <= 2000;
        const travel = walk ? "walk" : trip.withCar ? "car" : "transport";
        return {
          place: optionPlace(o),
          kind: o.kind,
          reason: o.reason,
          distanceMeters: o.m,
          travel,
          travelMinutes: walk
            ? Math.round(((o.m * 1.3) / 4500) * 60)
            : Math.round(((o.m * 1.3) / 35000) * 60) || 1,
          kidsFriendly: o.kind === "museums",
        };
      }),
    })),
  }));
}

/** Дни 1…days и пересчитанные варианты. */
function refresh(plan: PlanMock): PlanMock {
  const byDay = new Map(plan.plan.map((d) => [d.dayNo, d.items]));
  plan.plan = Array.from({ length: plan.trip.days }, (_, k) => ({
    dayNo: k + 1,
    items: byDay.get(k + 1) ?? [],
  }));
  plan.options = planOptions(plan.trip, new Set(plan.plan.flatMap((d) => d.items.map((i) => i.place.id))));
  return plan;
}

export function newBlock5State(): Block5State {
  return { staff: false, acceptingNow: true, serviceRequests: [], plans: [], aiPlanner: false, aiCalls: 0 };
}

/** Живые планы «от Claude» по кругу: по три места каталога (ранок, день, вечір) на первый день. */
const AI_VARIANTS: readonly { title: string; items: readonly [string, string, string][] }[] = [
  {
    title: "Водоспад, колиба й чани",
    items: [
      ["00000000-0000-4000-8000-000000000a02", "10:00", "morning"],
      ["00000000-0000-4000-8000-000000000a04", "13:00", "afternoon"],
      ["00000000-0000-4000-8000-000000000a08", "18:00", "evening"],
    ],
  },
  {
    title: "Музей, ринок і вечеря",
    items: [
      ["00000000-0000-4000-8000-000000000a03", "10:30", "morning"],
      ["00000000-0000-4000-8000-000000000a06", "14:00", "afternoon"],
      ["00000000-0000-4000-8000-000000000a07", "18:30", "evening"],
    ],
  },
];

function aiPlanDays(n: number): { dayNo: number; items: ItemMock[] }[] {
  const v = AI_VARIANTS[n % AI_VARIANTS.length]!;
  return [
    {
      dayNo: 1,
      items: v.items.map(([id, time, slot], k) => ({
        id: `00000000-0000-4000-8000-0000000c${String(n).padStart(2, "0")}0${k}`,
        position: k,
        timeHint: time,
        durationMin: 90,
        note: { uk: "Порада від плану." },
        place: optionPlace(OPTION_SEEDS.find((o) => o.id === id)!),
        available: true,
        alternatives: [],
        distanceFromPreviousMeters: null,
        replaced: false,
        slot,
      })),
    },
  ];
}

const SERVICES = [
  { code: "cleaning", title: { uk: "Прибирання номера" }, description: null, slaMinutes: 60, sortOrder: 1 },
  { code: "towels", title: { uk: "Заміна рушників" }, description: null, slaMinutes: 30, sortOrder: 2 },
];
const TRANSITIONS: Record<string, string[]> = {
  new: ["accepted", "rejected"],
  accepted: ["in_progress", "rejected"],
  in_progress: ["done"],
};
const place = (id: string, name: string, lat: number, lon: number): PlaceMock => ({
  id,
  categoryId: "00000000-0000-4000-8000-000000000102",
  name: { uk: name },
  address: null,
  location: { lat, lon },
});
const scenarioPlan = (): { dayNo: number; items: ItemMock[] }[] => [
  {
    dayNo: 1,
    items: [
      {
        id: "00000000-0000-4000-8000-000000000711",
        position: 1,
        timeHint: "09:00",
        slot: "morning",
        durationMin: 60,
        note: { uk: "Сніданок" },
        place: place(CAFE, "Кав'ярня «Смерека»", 48.4512, 24.5612),
        available: true,
        alternatives: [place(PIZZA, "Піцерія «Реклама»", 48.4535, 24.5635)],
        distanceFromPreviousMeters: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000712",
        position: 2,
        timeHint: "12:00",
        slot: "afternoon",
        durationMin: null,
        note: null,
        place: place(HOTEL_PLACE, "Тестовий готель", 48.45, 24.56),
        available: true,
        alternatives: [],
        distanceFromPreviousMeters: 350,
      },
    ],
  },
];
const scenarioSummary = {
  id: SCENARIO_ID,
  code: "one-day",
  title: { uk: "Один день у місті" },
  description: { uk: "Кава, обід і прогулянка." },
  days: 1,
  tags: [],
  adLabel: null,
  itemCount: 2,
};

type Json = (route: Route, body: unknown, status?: number) => Promise<void>;

export async function installBlock5Mock(
  page: Page,
  state: Block5State,
  json: Json,
  cors: Record<string, string>,
  token: string,
): Promise<void> {
  const requestDto = (r: ServiceRequestMock, staff: boolean) => ({
    id: r.id,
    regionId: REGION_ID,
    placeId: HOTEL_PLACE,
    placeName: { uk: "Тестовий готель" },
    serviceCode: r.serviceCode,
    serviceTitle: SERVICES.find((s) => s.code === r.serviceCode)!.title,
    room: { label: r.roomLabel, source: "guest" },
    comment: r.comment,
    status: r.status,
    statusReason: r.statusReason,
    outsideHours: r.outsideHours,
    processFrom: r.outsideHours ? "2026-11-03T06:00:00Z" : null,
    slaDueAt: "2026-11-02T11:00:00Z",
    overdue: false,
    cancellable: r.status === "new" || r.status === "accepted",
    createdAt: "2026-11-02T10:00:00Z",
    updatedAt: "2026-11-02T10:00:00Z",
    history: [],
    ...(staff ? { guestName: "Олена", allowedTransitions: TRANSITIONS[r.status] ?? [] } : {}),
  });
  const error = (route: Route, status: number, code: string, messageKey?: string) =>
    json(route, { error: { code, ...(messageKey ? { messageKey } : {}) } }, status);

  await page.route(
    (url) =>
      /^\/(host\/.+|service-requests|me\/service-requests.*|staff\/.+|scenarios.*|me\/plan.*)$/.test(
        url.pathname,
      ),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const query = Object.fromEntries(url.searchParams);
      const body = (method === "GET" ? {} : (req.postDataJSON() ?? {})) as Record<string, unknown>;
      const regionId = (body.regionId as string | undefined) ?? query.regionId;
      const signedIn = req.headers()["authorization"] === `Bearer ${token}`;

      if (path === `/host/${HOTEL_PLACE}/module`) {
        if (regionId !== REGION_ID) return error(route, 404, "NOT_FOUND");
        return json(route, {
          placeId: HOTEL_PLACE,
          regionId: REGION_ID,
          placeName: { uk: "Тестовий готель" },
          wifi: { ssid: "TestHotel", password: query.entryContextId ? "welcome123" : null },
          receptionPhone: "+380501234567",
          hours: { from: "08:00", to: "22:00", timezone: "Europe/Kyiv" },
          acceptingNow: state.acceptingNow,
          nextOpensAt: state.acceptingNow ? null : "2026-11-03T06:00:00Z",
          sections: [
            {
              kind: "rules",
              title: { uk: "Правила проживання" },
              content: { uk: "Тиша після 22:00." },
              sortOrder: 1,
            },
            { kind: "checkout", title: { uk: "Checkout" }, content: { uk: "До 12:00." }, sortOrder: 2 },
          ],
          services: SERVICES,
          room: null,
        });
      }
      if (path === "/scenarios") {
        if (regionId !== REGION_ID) return error(route, 404, "NOT_FOUND");
        return json(route, { items: [scenarioSummary] });
      }
      if (path === `/scenarios/${SCENARIO_ID}`)
        return json(route, { ...scenarioSummary, version: 1, plan: scenarioPlan() });
      if (!signedIn) return error(route, 401, "UNAUTHENTICATED", "errors.unauthenticated");

      if (path === "/service-requests" && method === "POST") {
        const key = req.headers()["idempotency-key"];
        if (!key) return error(route, 400, "VALIDATION_FAILED");
        const same = state.serviceRequests.find((r) => r.idempotencyKey === key);
        if (same) return json(route, requestDto(same, false), 201);
        const active = state.serviceRequests.some(
          (r) => r.serviceCode === body.serviceCode && ["new", "accepted", "in_progress"].includes(r.status),
        );
        if (active) return error(route, 409, "CONFLICT", "errors.serviceRequests.duplicate");
        const r: ServiceRequestMock = {
          id: `00000000-0000-4000-8000-0000000006${String(state.serviceRequests.length + 1).padStart(2, "0")}`,
          serviceCode: body.serviceCode as string,
          roomLabel: body.roomLabel as string,
          status: "new",
          statusReason: null,
          comment: (body.comment as string | undefined) ?? null,
          outsideHours: !state.acceptingNow,
          idempotencyKey: key,
        };
        state.serviceRequests.unshift(r);
        return json(route, requestDto(r, false), 201);
      }
      if (path === "/me/service-requests")
        return json(route, { items: state.serviceRequests.map((r) => requestDto(r, false)) });
      if (path === "/staff/places")
        return json(route, {
          items: state.staff
            ? [
                {
                  placeId: HOTEL_PLACE,
                  regionId: REGION_ID,
                  name: { uk: "Тестовий готель" },
                  role: "ORG_STAFF",
                  openRequests: state.serviceRequests.length,
                },
              ]
            : [],
        });
      if (path === "/staff/service-requests") {
        if (!state.staff) return error(route, 403, "FORBIDDEN");
        const items = state.serviceRequests.filter((r) => !query.status || r.status === query.status);
        return json(route, { items: items.map((r) => requestDto(r, true)) });
      }
      const statusOf = /^\/staff\/service-requests\/([^/]+)\/status$/.exec(path)?.[1];
      if (statusOf && method === "PATCH") {
        const r = state.serviceRequests.find((x) => x.id === statusOf);
        if (!r) return error(route, 404, "NOT_FOUND");
        if (!(TRANSITIONS[r.status] ?? []).includes(body.status as string))
          return error(route, 409, "CONFLICT", "errors.serviceRequests.invalidTransition");
        r.status = body.status as string;
        r.statusReason = (body.reason as string | undefined) ?? null;
        return json(route, requestDto(r, true));
      }
      if (path === "/me/plan" && method === "GET")
        return json(route, { items: state.plans.map((p) => ({ ...p, options: [] })) });
      if (path === "/me/plan" && method === "POST") {
        const custom = !body.scenarioId;
        const ai = custom && state.aiPlanner && body.ai !== false;
        // «Claude думает» — видно ожидание «Складаємо план…».
        if (ai) await new Promise((r) => setTimeout(r, 400));
        const plan: PlanMock = refresh({
          id: PLAN_ID,
          regionId: REGION_ID,
          scenarioId: custom ? null : SCENARIO_ID,
          scenarioVersion: custom ? null : 1,
          scenarioUpdated: false,
          title: ai
            ? { uk: AI_VARIANTS[state.aiCalls % AI_VARIANTS.length]!.title }
            : custom
              ? { uk: "Мій план", en: "My plan" }
              : scenarioSummary.title,
          startDate: (body.startDate as string | null | undefined) ?? null,
          trip: {
            adults: (body.adults as number | undefined) ?? 2,
            children: (body.children as number | undefined) ?? 0,
            withCar: (body.withCar as boolean | undefined) ?? true,
            days: (body.days as number | undefined) ?? 1,
            base: body.basePlaceId
              ? { kind: "place", placeId: body.basePlaceId, name: { uk: "Тестовий готель" } }
              : null,
          },
          plan: ai
            ? aiPlanDays(state.aiCalls)
            : custom
              ? []
              : scenarioPlan().map((d) => ({
                  ...d,
                  items: d.items.map((i) => ({ ...i, replaced: false })),
                })),
          options: [],
          createdAt: "2026-11-02T10:00:00Z",
          updatedAt: "2026-11-02T10:00:00Z",
        });
        state.plans = [plan];
        if (ai) state.aiCalls++;
        return json(route, { ...plan, generation: ai ? "ai" : null }, 201);
      }
      const regen = /^\/me\/plan\/([^/]+)\/regenerate$/.exec(path)?.[1];
      if (regen && method === "POST") {
        const target = state.plans.find((p) => p.id === regen);
        if (!target || !state.aiPlanner) return error(route, 404, "NOT_FOUND");
        if (target.scenarioId) return error(route, 422, "UNPROCESSABLE", "errors.plan.notCustom");
        await new Promise((r) => setTimeout(r, 400));
        target.title = { uk: AI_VARIANTS[state.aiCalls % AI_VARIANTS.length]!.title };
        target.plan = aiPlanDays(state.aiCalls);
        state.aiCalls++;
        return json(route, { ...refresh(target), generation: "ai" });
      }
      const planId = /^\/me\/plan\/([^/]+)$/.exec(path)?.[1];
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return error(route, 404, "NOT_FOUND");
      if (method === "GET") return json(route, refresh(plan));
      if (method === "PATCH") {
        for (const key of ["adults", "children", "withCar", "days"] as const)
          if (body[key] !== undefined) (plan.trip as Record<string, unknown>)[key] = body[key];
        if (body.startDate !== undefined) plan.startDate = body.startDate;
        if (body.days !== undefined) plan.plan = plan.plan.filter((d) => d.dayNo <= plan.trip.days);
        const add = body.addItem as { dayNo: number; slot: string; placeId: string } | undefined;
        if (add) {
          const seed = OPTION_SEEDS.find((o) => o.id === add.placeId);
          if (!seed) return error(route, 422, "UNPROCESSABLE", "errors.plan.placeUnavailable");
          refresh(plan);
          const day = plan.plan.find((d) => d.dayNo === add.dayNo)!;
          day.items.push({
            id: `00000000-0000-4000-8000-0000000b${String(day.items.length + 1).padStart(2, "0")}${add.placeId.slice(-2)}`,
            position: day.items.length,
            timeHint: null,
            durationMin: null,
            note: null,
            place: optionPlace(seed),
            available: true,
            alternatives: [],
            distanceFromPreviousMeters: null,
            replaced: false,
            slot: add.slot,
          });
        }
        const replace = body.replaceItem as { itemId: string; placeId: string } | undefined;
        for (const day of plan.plan) {
          if (body.removeItemId) day.items = day.items.filter((i) => i.id !== body.removeItemId);
          for (const item of day.items) {
            if (!replace || item.id !== replace.itemId) continue;
            const alt = item.alternatives.find((a) => a.id === replace.placeId);
            if (!alt) return error(route, 422, "UNPROCESSABLE", "errors.plan.notAlternative");
            item.alternatives = [item.place, ...item.alternatives.filter((a) => a !== alt)];
            item.place = alt;
            item.replaced = true;
          }
        }
        return json(route, refresh(plan));
      }
      return error(route, 404, "NOT_FOUND");
    },
  );
}
