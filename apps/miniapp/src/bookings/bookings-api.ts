// Адаптер блока 7 (бронирования) поверх @tg/api-client: турист — C07/C08/C21 (регион из контекста входа), партнёр —
// P04/P05 и ресурсы (права — назначения ORG_* на сервере). Ошибки — как у блоков 5–6 (ok из host-api).
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import { ok } from "../host/host-api.js";

export type Resource = ApiSchemas["ResourceDto"];
export type SlotList = ApiSchemas["SlotListDto"];
export type Slot = ApiSchemas["SlotDto"];
export type Booking = ApiSchemas["BookingDto"];
export type PartnerBooking = ApiSchemas["PartnerBookingDto"];
export type BookingStatus = ApiSchemas["BookingStatus"];
export type BookingTarget = ApiSchemas["BookingTargetStatus"];
export type PartnerResource = ApiSchemas["PartnerResourceDto"];
export type ResourceInput = ApiSchemas["CreateResourceDto"];
export type ResourcePatch = ApiSchemas["UpdateResourceDto"];
export type AvailabilityRule = ApiSchemas["AvailabilityRuleDto"];
export type ManualAvailability = ApiSchemas["ManualAvailability"];
export type NewBooking = ApiSchemas["CreateBookingDto"];
export type ManualBooking = ApiSchemas["CreateManualBookingDto"];

export type StatusChange = { status: BookingTarget; reason?: string; alternativeStartsAt?: string };

export type BookingsApi = {
  resources(regionId: string, placeId: string): Promise<Resource[]>;
  slots(regionId: string, resourceId: string, from?: string, days?: number): Promise<SlotList>;
  create(input: NewBooking, idempotencyKey: string): Promise<Booking>;
  mine(regionId: string): Promise<Booking[]>;
  /** Турист: Booking; партнёр: PartnerBooking (сервер отвечает по роли). */
  setStatus(id: string, regionId: string, change: StatusChange): Promise<PartnerBooking>;
  partnerBookings(placeId: string, from: string, to: string): Promise<PartnerBooking[]>;
  createManual(input: ManualBooking, idempotencyKey: string): Promise<PartnerBooking>;
  partnerResources(placeId: string): Promise<PartnerResource[]>;
  createResource(input: ResourceInput): Promise<PartnerResource>;
  updateResource(id: string, patch: ResourcePatch): Promise<PartnerResource>;
  putAvailability(id: string, rules: AvailabilityRule[]): Promise<PartnerResource>;
  /** ttlMinutes обязателен в схеме и для unknown (сервер его игнорирует). */
  putManual(id: string, status: ManualAvailability, ttlMinutes: number): Promise<PartnerResource>;
};

export function createBookingsApi(api: ApiClient): BookingsApi {
  const path = (id: string) => ({ path: { id } });
  return {
    resources: async (regionId, placeId) =>
      (await ok(api.GET("/resources", { params: { query: { regionId, placeId } } }))).items,
    slots: (regionId, id, from, days) =>
      ok(
        api.GET("/resources/{id}/slots", {
          params: { ...path(id), query: { regionId, ...(from ? { from } : {}), ...(days ? { days } : {}) } },
        }),
      ),
    create: (body, key) =>
      ok(api.POST("/bookings", { params: { header: { "Idempotency-Key": key } }, body })),
    mine: async (regionId) => (await ok(api.GET("/bookings", { params: { query: { regionId } } }))).items,
    setStatus: (id, regionId, change) =>
      ok(api.PATCH("/bookings/{id}/status", { params: path(id), body: { regionId, ...change } })),
    partnerBookings: async (placeId, from, to) =>
      (await ok(api.GET("/partner/bookings", { params: { query: { placeId, from, to } } }))).items,
    createManual: (body, key) =>
      ok(api.POST("/partner/bookings", { params: { header: { "Idempotency-Key": key } }, body })),
    partnerResources: async (placeId) =>
      (await ok(api.GET("/partner/resources", { params: { query: { placeId } } }))).items,
    createResource: (body) => ok(api.POST("/partner/resources", { body })),
    updateResource: (id, body) => ok(api.PATCH("/partner/resources/{id}", { params: path(id), body })),
    putAvailability: (id, rules) =>
      ok(api.PUT("/partner/resources/{id}/availability", { params: path(id), body: { rules } })),
    putManual: (id, status, ttlMinutes) =>
      ok(
        api.PUT("/partner/resources/{id}/manual-availability", {
          params: path(id),
          body: { status, ttlMinutes },
        }),
      ),
  };
}
