// Адаптер HostApi поверх @tg/api-client: DTO блока 5 (HostModule, заявки, сценарии, UserPlan) → модель экранов.
// Регион — regionId из контекста входа (GET /context), как у гида.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import { API_URL } from "../api.js";
import { NotFoundError, UnauthorizedError } from "../guide/types.js";
import { safeIcon } from "../weather/weather-api.js";
import {
  ApiCallError,
  ConflictError,
  NetworkError,
  type HostApi,
  type PlanChange,
  type PlanDay,
  type PlanPlace,
  type RoomContext,
  type ScenarioSummary,
  type ServiceRequest,
  type UserPlan,
} from "./types.js";

type RequestDto = ApiSchemas["ServiceRequestDto"] | ApiSchemas["StaffServiceRequestDto"];
type ItemDto = ApiSchemas["ScenarioItemDto"] | ApiSchemas["UserPlanItemDto"];

const room = (r: ApiSchemas["RoomContextDto"] | null): RoomContext | null =>
  r ? { value: r.label, source: r.source } : null;

export function requestOf(dto: RequestDto): ServiceRequest {
  return {
    id: dto.id,
    placeId: dto.placeId,
    placeName: dto.placeName,
    service: dto.serviceTitle,
    status: dto.status,
    statusReason: dto.statusReason,
    comment: dto.comment,
    room: room(dto.room),
    createdAt: dto.createdAt,
    processFrom: dto.outsideHours ? dto.processFrom : null,
    overdue: dto.overdue,
    cancellable: dto.cancellable,
    guestName: "guestName" in dto ? dto.guestName : null,
    transitions: "allowedTransitions" in dto ? dto.allowedTransitions : [],
  };
}

const placeOf = (p: ApiSchemas["PlanPlaceDto"]): PlanPlace => ({ id: p.id, name: p.name });

function daysOf(days: { dayNo: number; items: ItemDto[] }[]): PlanDay[] {
  return days.map((d) => ({
    day: d.dayNo,
    items: [...d.items]
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        id: i.id,
        time: i.timeHint,
        place: i.place && i.available ? placeOf(i.place) : null,
        note: i.note,
        alternatives: i.alternatives.map(placeOf),
        distanceMeters: i.distanceFromPreviousMeters,
        slot: i.slot,
        ...("weatherWarnings" in i && i.weatherWarnings.length ? { weatherWarnings: i.weatherWarnings } : {}),
      })),
  }));
}

/** Сезон даты поездки YYYY-MM-DD — как в api (season.ts): зима — грудень–лютий, весна, літо, осінь. */
export function seasonOfDate(date: string): "winter" | "spring" | "summer" | "autumn" {
  const m = Number(date.slice(5, 7));
  return m === 12 || m <= 2 ? "winter" : m <= 5 ? "spring" : m <= 8 ? "summer" : "autumn";
}

const scenarioOf = (s: ApiSchemas["ScenarioSummaryDto"]): ScenarioSummary => ({
  id: s.id,
  title: s.title,
  description: s.description,
  days: s.days,
  adLabel: s.adLabel,
});

export const planOf = (p: ApiSchemas["UserPlanDto"]): UserPlan => ({
  id: p.id,
  scenarioId: p.scenarioId,
  title: p.title,
  schedule: daysOf(p.plan),
  scenarioUpdated: p.scenarioUpdated,
  updatedAt: p.updatedAt,
  startDate: p.startDate,
  trip: { adults: p.trip.adults, children: p.trip.children, withCar: p.trip.withCar, days: p.trip.days },
  base: p.trip.base?.name ?? null,
  options: p.options.map((d) => ({
    day: d.dayNo,
    slots: d.slots.map((s) => ({
      slot: s.slot,
      options: s.options.map((o) => ({
        place: { id: o.place.id, name: o.place.name, categoryName: o.place.categoryName },
        kind: o.kind,
        reason: o.reason,
        distanceMeters: o.distanceMeters,
        travel: o.travel,
        travelMinutes: o.travelMinutes,
        kidsFriendly: o.kidsFriendly,
      })),
    })),
  })),
  // Старый ответ api без погоды — без погоды. Иконки — только наш прокси (safeIcon).
  weather: (p.weather ?? []).map(({ dayNo, ...w }) => ({
    ...w,
    day: dayNo,
    iconUrl: safeIcon(w.iconUrl, API_URL),
  })),
  weatherSource: p.weatherSource ?? null,
  // Старый ответ api без поля — без Claude.
  generation: p.generation ?? null,
});

/** Правка плана → тело PATCH /me/plan/{id}. */
function patchOf(change: PlanChange) {
  if ("replace" in change) return { replaceItem: change.replace };
  if ("remove" in change) return { removeItemId: change.remove };
  if ("add" in change)
    return { addItem: { dayNo: change.add.day, slot: change.add.slot, placeId: change.add.placeId } };
  return change.trip;
}

/** Ответ api: data при 2xx; 404/401/409 — свои ошибки; прочее — ApiCallError с messageKey сервера. */
export async function ok<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let res: Awaited<typeof p>;
  try {
    res = await p;
  } catch {
    throw new NetworkError();
  }
  const status = res.response.status;
  if (res.response.ok && res.data !== undefined) return res.data;
  if (status === 404) throw new NotFoundError();
  if (status === 401) throw new UnauthorizedError();
  const env = (
    res.error as { error?: { code?: string; messageKey?: string; details?: Record<string, unknown> } }
  )?.error;
  const key = env?.messageKey ?? null;
  const code = env?.code ?? null;
  if (status === 409) throw new ConflictError(key, code, env?.details ?? null);
  throw new ApiCallError(status, key, code, env?.details ?? null);
}

export function createHostApi(api: ApiClient, regionId: string | null): HostApi {
  const region = () => {
    if (!regionId) throw new Error("no region");
    return regionId;
  };
  return {
    hostModule: async (placeId, entryContextId) => {
      const m = await ok(
        api.GET("/host/{placeId}/module", {
          params: {
            path: { placeId },
            query: { regionId: region(), ...(entryContextId ? { entryContextId } : {}) },
          },
        }),
      );
      return {
        placeId: m.placeId,
        name: m.placeName,
        sections: [...m.sections]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({ kind: s.kind, title: s.title, content: s.content })),
        wifi: m.wifi,
        phone: m.receptionPhone,
        intake: m.hours ? { from: m.hours.from, to: m.hours.to } : null,
        acceptingNow: m.acceptingNow,
        room: room(m.room),
        services: [...m.services]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({ id: s.code, title: s.title, description: s.description, slaMinutes: s.slaMinutes })),
      };
    },
    createRequest: async (r) =>
      requestOf(
        await ok(
          api.POST("/service-requests", {
            params: { header: { "Idempotency-Key": r.idempotencyKey } },
            body: {
              regionId: region(),
              placeId: r.placeId,
              serviceCode: r.serviceId,
              ...(r.entryContextId ? { entryContextId: r.entryContextId } : {}),
              ...(r.roomLabel ? { roomLabel: r.roomLabel } : {}),
              ...(r.comment ? { comment: r.comment } : {}),
            },
          }),
        ),
      ),
    myRequests: async () =>
      (await ok(api.GET("/me/service-requests", { params: { query: { regionId: region() } } }))).items.map(
        requestOf,
      ),
    cancelRequest: async (id) =>
      requestOf(
        await ok(
          api.POST("/me/service-requests/{id}/cancel", {
            params: { path: { id } },
            body: { regionId: region() },
          }),
        ),
      ),
    staffRequests: async (status) =>
      (
        await ok(api.GET("/staff/service-requests", { params: { query: status ? { status } : {} } }))
      ).items.map(requestOf),
    setStatus: async (id, status, reason) =>
      requestOf(
        await ok(
          api.PATCH("/staff/service-requests/{id}/status", {
            params: { path: { id } },
            body: { status, ...(reason ? { reason } : {}) },
          }),
        ),
      ),
    scenarios: async (tripDate) =>
      (
        await ok(
          api.GET("/scenarios", {
            params: {
              query: { regionId: region(), ...(tripDate ? { season: seasonOfDate(tripDate) } : {}) },
            },
          }),
        )
      ).items.map(scenarioOf),
    scenario: async (id) => {
      const s = await ok(
        api.GET("/scenarios/{id}", { params: { path: { id }, query: { regionId: region() } } }),
      );
      return { ...scenarioOf(s), schedule: daysOf(s.plan) };
    },
    plans: async () =>
      (await ok(api.GET("/me/plan", { params: { query: { regionId: region() } } }))).items.map(planOf),
    plan: async (id) =>
      planOf(await ok(api.GET("/me/plan/{id}", { params: { path: { id }, query: { regionId: region() } } }))),
    savePlan: async (scenarioId, startDate) =>
      planOf(
        await ok(
          api.POST("/me/plan", {
            body: { regionId: region(), scenarioId, ...(startDate ? { startDate } : {}) },
          }),
        ),
      ),
    createPlan: async (trip) =>
      planOf(await ok(api.POST("/me/plan", { body: { regionId: region(), ...trip } }))),
    regeneratePlan: async (id) =>
      planOf(
        await ok(
          api.POST("/me/plan/{id}/regenerate", { params: { path: { id } }, body: { regionId: region() } }),
        ),
      ),
    updatePlan: async (id, change) =>
      planOf(
        await ok(
          api.PATCH("/me/plan/{id}", {
            params: { path: { id } },
            body: { regionId: region(), ...patchOf(change) },
          }),
        ),
      ),
  };
}
