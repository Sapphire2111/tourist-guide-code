// Мок api бронирований (блок 7) для E2E Mini App: ресурсы и слоты места (C07), онлайн-бронь с согласием и
// Idempotency-Key (C08), «Мої бронювання» (C21), брони и ресурсы партнёра (P04/P05). Время — местное время региона
// (Europe/Kyiv), слоты — завтра 10:00–13:00. Правила (согласие обязательно, занятый слот — 409, version — 409) —
// как в bookings.service сервера, в упрощённом виде. Не свои пути — дальше другим мокам (route.fallback).
import type { Page, Route } from "@playwright/test";
import { CAFE_PLACE, REGION_ID } from "./api-mock.js";

export const RESOURCE_ID = "00000000-0000-4000-8000-000000000301";
export const PARTNER_PLACE = "00000000-0000-4000-8000-00000000b001";
const PARTNER_RESOURCE = "00000000-0000-4000-8000-000000000302";
const TZ = "Europe/Kyiv";

function offset(instant: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - instant;
}

/** Местные дата (сдвиг дней от сегодня) и час в Києві → ISO UTC. */
export function kyiv(dayOffset: number, hour: number): string {
  const now = Date.now();
  const local = new Date(now + offset(now));
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour);
  return new Date(guess - offset(guess - offset(guess))).toISOString();
}

type Booking = Record<string, unknown> & { id: string; status: string; startsAt: string; resourceId: string };

export type BookingsMockState = {
  bookings: Booking[];
  /** Тела POST /bookings с ключами идемпотентности. */
  created: { body: Record<string, unknown>; key: string | null }[];
  statusChanges: Record<string, unknown>[];
  manual: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  /** Следующая правка ресурса — 409 versionConflict (ресурс «изменил» другой сотрудник). */
  conflictOnce: boolean;
  manualStatus: Record<string, unknown>[];
};

const name = (uk: string) => ({ uk });

const touristResource = () => ({
  id: RESOURCE_ID,
  regionId: REGION_ID,
  placeId: CAFE_PLACE,
  name: name("Чан №1"),
  description: null,
  capacityPeople: 4,
  slotDurationMin: 60,
  bookingMode: "request_confirm",
  priceMinor: 80000,
  currency: "UAH",
  availability: { availableNow: true, source: "manual", manualExpiresAt: kyiv(0, 23) },
});

function partnerResource(version = 1) {
  return {
    id: PARTNER_RESOURCE,
    regionId: REGION_ID,
    placeId: PARTNER_PLACE,
    organizationId: "00000000-0000-4000-8000-00000000a001",
    name: name("Чан біля річки"),
    description: null,
    capacityPeople: 6,
    slotDurationMin: 60,
    bookingMode: "request_confirm",
    priceMinor: null,
    currency: null,
    availability: { availableNow: false, source: null, manualExpiresAt: null },
    status: "active",
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    leadTimeMin: 60,
    horizonDays: 30,
    confirmSlaMin: 30,
    manualAvailability: "unknown",
    rules: [{ dayOfWeek: 1, date: null, closed: false, opensAt: "10:00", closesAt: "20:00" }],
    version,
    updatedAt: "2026-11-03T08:00:00Z",
  };
}

export function bookingDto(over: Partial<Booking> & { id: string }): Booking {
  return {
    regionId: REGION_ID,
    placeId: PARTNER_PLACE,
    placeName: name("Садиба «Під Смерекою»"),
    resourceId: PARTNER_RESOURCE,
    resourceName: name("Чан біля річки"),
    status: "pending_partner",
    statusReason: null,
    startsAt: kyiv(0, 18),
    endsAt: kyiv(0, 19),
    peopleCount: 3,
    comment: "Будемо з дітьми",
    alternative: null,
    partnerResponseDueAt: kyiv(0, 17),
    allowedTransitions: ["confirmed", "alternative_proposed", "cancelled_by_partner"],
    history: [],
    createdAt: "2026-11-03T08:00:00Z",
    updatedAt: "2026-11-03T08:00:00Z",
    organizationId: "00000000-0000-4000-8000-00000000a001",
    source: "platform",
    customerName: "Олена Коваль",
    contactPhone: "+380501234567",
    ...over,
  };
}

const USER_TRANSITIONS: Record<string, string[]> = {
  pending_partner: ["cancelled_by_user"],
  alternative_proposed: ["confirmed", "cancelled_by_user"],
  confirmed: ["cancelled_by_user"],
};
const PARTNER_TRANSITIONS: Record<string, string[]> = {
  pending_partner: ["confirmed", "alternative_proposed", "cancelled_by_partner"],
  alternative_proposed: ["cancelled_by_partner"],
  confirmed: ["completed", "no_show", "cancelled_by_partner"],
};

export async function installBookingsMock(
  page: Page,
  token = "e2e-session-token",
): Promise<BookingsMockState> {
  const state: BookingsMockState = {
    bookings: [],
    created: [],
    statusChanges: [],
    manual: [],
    resources: [partnerResource()],
    conflictOnce: false,
    manualStatus: [],
  };
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, messageKey?: string, details?: unknown) =>
    json(
      route,
      { error: { code, ...(messageKey ? { messageKey } : {}), ...(details ? { details } : {}) } },
      status,
    );
  // Модуль бронирований включён (флаг module.bookings) вместе с модулями из общей фикстуры.
  await page.route("**/feature-flags*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: ["module.partner_cabinet", "module.host_requests", "module.bookings"].map((key) => ({
          key,
          enabled: true,
        })),
      }),
    }),
  );
  const slotStarts = () => [10, 11, 12].map((h) => kyiv(1, h));
  const taken = (iso: string) =>
    state.bookings.some((b) => b.startsAt === iso && !String(b.status).startsWith("cancelled"));

  await page.route(
    (url) =>
      /^\/(resources(\/[^/]+\/slots)?|bookings(\/[^/]+\/status)?|partner\/(bookings|resources)(\/.*)?)$/.test(
        url.pathname,
      ),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const query = Object.fromEntries(url.searchParams);
      const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});

      // Публичные: ресурсы и слоты (без входа), регион — обязателен.
      if (path === "/resources" && method === "GET") {
        if (query.regionId !== REGION_ID) return error(route, 404, "NOT_FOUND");
        return json(route, { items: query.placeId === CAFE_PLACE ? [touristResource()] : [] });
      }
      if (/^\/resources\/[^/]+\/slots$/.test(path)) {
        const items = slotStarts().map((s) => ({
          startsAt: s,
          endsAt: new Date(Date.parse(s) + 3_600_000).toISOString(),
          free: !taken(s),
        }));
        return json(route, {
          resourceId: path.split("/")[2],
          timezone: TZ,
          from: kyiv(0, 12).slice(0, 10),
          days: 2,
          items,
          availability: touristResource().availability,
        });
      }

      if (req.headers()["authorization"] !== `Bearer ${token}`)
        return error(route, 401, "UNAUTHENTICATED", "errors.unauthenticated");

      if (path === "/bookings" && method === "POST") {
        const b = body();
        state.created.push({ body: b, key: req.headers()["idempotency-key"] ?? null });
        if (!req.headers()["idempotency-key"]) return error(route, 400, "IDEMPOTENCY_KEY_REQUIRED");
        if (b.phoneShareConsent !== true)
          return error(route, 422, "UNPROCESSABLE", "errors.booking.phoneConsentRequired");
        if (taken(String(b.startsAt))) return error(route, 409, "CONFLICT", "errors.booking.slotTaken");
        const created = bookingDto({
          id: `00000000-0000-4000-8000-0000000004${String(state.bookings.length + 1).padStart(2, "0")}`,
          placeId: CAFE_PLACE,
          placeName: name("Кав'ярня «Смерека»"),
          resourceId: RESOURCE_ID,
          resourceName: name("Чан №1"),
          startsAt: String(b.startsAt),
          endsAt: new Date(Date.parse(String(b.startsAt)) + 3_600_000).toISOString(),
          peopleCount: Number(b.peopleCount),
          comment: (b.comment as string | undefined) ?? null,
          partnerResponseDueAt: kyiv(1, 9),
          allowedTransitions: USER_TRANSITIONS.pending_partner!,
          source: "platform",
        });
        state.bookings.push(created);
        return json(route, created, 201);
      }
      if (path === "/bookings" && method === "GET")
        return json(route, { items: state.bookings.filter((b) => b.placeId === CAFE_PLACE) });
      const statusOf = /^\/bookings\/([^/]+)\/status$/.exec(path)?.[1];
      if (statusOf && method === "PATCH") {
        const b = body();
        state.statusChanges.push({ id: statusOf, ...b });
        const booking = state.bookings.find((x) => x.id === statusOf);
        if (!booking) return error(route, 404, "NOT_FOUND");
        const partnerSide = booking.placeId === PARTNER_PLACE;
        const allowed = (partnerSide ? PARTNER_TRANSITIONS : USER_TRANSITIONS)[booking.status] ?? [];
        if (!allowed.includes(String(b.status)))
          return error(route, 409, "CONFLICT", "errors.booking.invalidTransition", {
            currentStatus: booking.status,
          });
        if (booking.status === "alternative_proposed" && b.status === "confirmed" && booking.alternative) {
          const alt = booking.alternative as { startsAt: string; endsAt: string };
          Object.assign(booking, { startsAt: alt.startsAt, endsAt: alt.endsAt, alternative: null });
        }
        if (b.status === "cancelled_by_user" && booking.status === "alternative_proposed")
          Object.assign(booking, { statusReason: "alternative_declined", alternative: null });
        if (b.status === "cancelled_by_partner") booking.statusReason = b.reason ?? null;
        booking.status = String(b.status);
        booking.allowedTransitions =
          (partnerSide ? PARTNER_TRANSITIONS : USER_TRANSITIONS)[booking.status] ?? [];
        return json(route, booking);
      }

      // Партнёр.
      if (path === "/partner/bookings" && method === "GET") {
        const from = query.from ? Date.parse(query.from) : -Infinity;
        const to = query.to ? Date.parse(query.to) : Infinity;
        return json(route, {
          items: state.bookings.filter(
            (b) =>
              b.placeId === PARTNER_PLACE && Date.parse(b.startsAt) >= from && Date.parse(b.startsAt) < to,
          ),
        });
      }
      if (path === "/partner/bookings" && method === "POST") {
        const b = body();
        state.manual.push(b);
        if (taken(String(b.startsAt))) return error(route, 409, "CONFLICT", "errors.booking.slotTaken");
        const created = bookingDto({
          id: `00000000-0000-4000-8000-0000000005${String(state.manual.length).padStart(2, "0")}`,
          status: "confirmed",
          startsAt: String(b.startsAt),
          endsAt: new Date(Date.parse(String(b.startsAt)) + 3_600_000).toISOString(),
          peopleCount: Number(b.peopleCount),
          customerName: String(b.customerName),
          contactPhone: (b.customerPhone as string | undefined) ?? null,
          comment: null,
          source: String(b.source ?? "manual"),
          partnerResponseDueAt: null,
          allowedTransitions: PARTNER_TRANSITIONS.confirmed!,
        });
        state.bookings.push(created);
        return json(route, created, 201);
      }
      if (path === "/partner/resources" && method === "GET")
        return json(route, { items: state.resources.filter((r) => r.placeId === query.placeId) });
      const resId = /^\/partner\/resources\/([^/]+)/.exec(path)?.[1];
      const res = state.resources.find((r) => r.id === resId);
      if (resId && !res) return error(route, 404, "NOT_FOUND");
      if (res && path.endsWith("/manual-availability") && method === "PUT") {
        const b = body();
        state.manualStatus.push(b);
        const until = new Date(Date.now() + Number(b.ttlMinutes) * 60_000).toISOString();
        Object.assign(res, {
          manualAvailability: b.status,
          availability:
            b.status === "unknown"
              ? { availableNow: false, source: null, manualExpiresAt: null }
              : {
                  availableNow: b.status === "available_now",
                  source: b.status === "available_now" ? "manual" : null,
                  manualExpiresAt: until,
                },
        });
        return json(route, res);
      }
      if (res && path.endsWith("/availability") && method === "PUT") {
        Object.assign(res, {
          rules: (body().rules as unknown[]).map((r) => ({
            dayOfWeek: null,
            date: null,
            closed: false,
            opensAt: null,
            closesAt: null,
            ...(r as object),
          })),
        });
        return json(route, res);
      }
      if (res && method === "PATCH") {
        const b = body();
        if (state.conflictOnce || b.version !== res.version) {
          state.conflictOnce = false;
          res.version = Number(res.version) + 1;
          return error(route, 409, "CONFLICT", "errors.resource.versionConflict", {
            currentVersion: res.version,
          });
        }
        Object.assign(res, b, { version: Number(res.version) + 1 });
        return json(route, res);
      }
      return route.fallback();
    },
  );
  return state;
}
