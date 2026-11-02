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
};
type PlanMock = { id: string; plan: { dayNo: number; items: ItemMock[] }[] } & Record<string, unknown>;

export function newBlock5State(): Block5State {
  return { staff: false, acceptingNow: true, serviceRequests: [], plans: [] };
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
      if (path === "/me/plan" && method === "GET") return json(route, { items: state.plans });
      if (path === "/me/plan" && method === "POST") {
        const plan: PlanMock = {
          id: PLAN_ID,
          regionId: REGION_ID,
          scenarioId: SCENARIO_ID,
          scenarioVersion: 1,
          scenarioUpdated: false,
          title: scenarioSummary.title,
          startDate: null,
          plan: scenarioPlan().map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, replaced: false })) })),
          createdAt: "2026-11-02T10:00:00Z",
          updatedAt: "2026-11-02T10:00:00Z",
        };
        state.plans = [plan];
        return json(route, plan, 201);
      }
      const planId = /^\/me\/plan\/([^/]+)$/.exec(path)?.[1];
      const plan = state.plans.find((p) => p.id === planId);
      if (!plan) return error(route, 404, "NOT_FOUND");
      if (method === "GET") return json(route, plan);
      if (method === "PATCH") {
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
        return json(route, plan);
      }
      return error(route, 404, "NOT_FOUND");
    },
  );
}
