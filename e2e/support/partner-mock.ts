// Мок api кабинета партнёра (блок 6) для E2E Mini App: онбординг, редактор места, график, фото (подписанная
// ссылка PUT), отправка на модерацию, акции, сотрудники и приглашения. Состояние — на страницу, правила
// (обязательные поля шаблона, права ролей) — как в partner-rules сервера, в упрощённом виде.
import type { Page, Route } from "@playwright/test";
import { REGION_ID } from "./api-mock.js";

export const INVITE_TOKEN = "e2eInviteToken".padEnd(43, "x");
const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const INVITED_ORG_ID = "00000000-0000-4000-8000-00000000a002";
const INVITED_PLACE_ID = "00000000-0000-4000-8000-00000000b002";
const PLACE_ID = "00000000-0000-4000-8000-00000000b001";
const CATEGORY = {
  id: "00000000-0000-4000-8000-00000000c001",
  code: "hotels",
  name: { uk: "Готелі та садиби" },
};
const REQUIRED = ["name", "category", "address", "phone", "schedule", "photo"] as const;

const TEMPLATE = {
  id: "00000000-0000-4000-8000-00000000d001",
  code: "hotel",
  name: { uk: "Готель / садиба" },
  description: { uk: "Для готелів, садиб і гостьових будинків" },
  requiredFields: [...REQUIRED],
  modules: ["host_requests", "offers"],
  categories: [CATEGORY],
};

type PlaceState = {
  id: string;
  orgId: string;
  role: "ORG_OWNER" | "ORG_MANAGER" | "ORG_STAFF";
  status: string;
  name: { uk: string };
  address: { uk: string } | null;
  description: { uk: string } | null;
  phone: string | null;
  weekly: { dayOfWeek: number; opensAt: string; closesAt: string }[];
  media: string[];
  moderation: Record<string, unknown> | null;
  /** Растёт при каждом изменении (как updated_at в БД). */
  version: number;
};

export type PartnerMockState = {
  orgs: { id: string; name: string; role: PlaceState["role"] }[];
  places: PlaceState[];
  uploads: number;
  submitNote: string | null;
  acceptedInvite: boolean;
};

export function newPartnerState(): PartnerMockState {
  return { orgs: [], places: [], uploads: 0, submitNote: null, acceptedInvite: false };
}

const abilities = (role: string) => ({
  editPlace: role !== "ORG_STAFF",
  editIdentity: role === "ORG_OWNER",
  submit: role === "ORG_OWNER",
  manageStaff: role === "ORG_OWNER",
  manageOffers: role !== "ORG_STAFF",
  managePriceList: role !== "ORG_STAFF",
  serviceRequests: true,
  bookings: true,
  manualBooking: true,
  manageResources: role !== "ORG_STAFF",
  editAvailability: role !== "ORG_STAFF",
  manualAvailability: true,
  customerPhone: role !== "ORG_STAFF",
});

function missing(p: PlaceState): string[] {
  const has: Record<string, boolean> = {
    name: !!p.name.uk.trim(),
    category: true,
    address: !!p.address?.uk.trim(),
    phone: !!p.phone,
    schedule: p.weekly.length > 0,
    photo: p.media.length > 0,
  };
  return REQUIRED.filter((f) => !has[f]);
}

const summary = (p: PlaceState) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  templateCode: "hotel",
  modules: TEMPLATE.modules,
  moderation: p.moderation,
  openServiceRequests: 0,
  activeOffers: 0,
});

const placeDto = (p: PlaceState) => ({
  id: p.id,
  organizationId: p.orgId,
  regionId: REGION_ID,
  status: p.status,
  template: {
    code: "hotel",
    name: TEMPLATE.name,
    requiredFields: TEMPLATE.requiredFields,
    modules: TEMPLATE.modules,
    categories: [CATEGORY],
  },
  role: p.role,
  abilities: abilities(p.role),
  editable: ["draft", "changes_requested", "rejected", "published"].includes(p.status),
  categoryId: CATEGORY.id,
  localityId: null,
  name: p.name,
  description: p.description,
  address: p.address,
  location: null,
  phone: p.phone,
  website: null,
  telegram: null,
  tagIds: [],
  schedule: { timezone: "Europe/Kyiv", weekly: p.weekly, exceptions: [] },
  media: p.media.map((id, i) => ({
    mediaAssetId: id,
    sortOrder: i,
    isCover: i === 0,
    alt: { uk: "Фасад садиби" },
    status: "ready",
    mime: "image/jpeg",
  })),
  mediaPreview: Object.fromEntries(p.media.map((id) => [id, `https://cdn.example/${id}-w320.jpg`])),
  missingFields: missing(p),
  moderation: p.moderation,
  updatedAt: new Date(Date.UTC(2026, 10, 2) + p.version * 1000).toISOString(),
});

export async function installPartnerMock(page: Page, state: PartnerMockState, token: string): Promise<void> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, idempotency-key, content-length",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, messageKey?: string, details?: unknown) =>
    json(
      route,
      { error: { code, ...(messageKey ? { messageKey } : {}), ...(details ? { details } : {}) } },
      status,
    );

  // Загрузка файла по подписанной ссылке (хранилище, не api).
  await page.route("https://upload.example/**", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, body: "" }),
  );

  await page.route(
    (url) => url.pathname.startsWith("/partner/"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (req.headers()["authorization"] !== `Bearer ${token}`)
        return error(route, 401, "UNAUTHENTICATED", "errors.unauthenticated");
      const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});

      if (path === "/partner/me" && method === "GET")
        return json(route, {
          organizations: state.orgs.map((o) => ({
            id: o.id,
            regionId: REGION_ID,
            name: o.name,
            role: o.role,
            assignmentId: `${o.id.slice(0, -4)}f001`,
            abilities: abilities(o.role),
            places: state.places.filter((p) => p.orgId === o.id).map(summary),
          })),
        });
      if (path === "/partner/templates" && method === "GET") {
        if (url.searchParams.get("regionId") !== REGION_ID) return error(route, 404, "NOT_FOUND");
        return json(route, { items: [TEMPLATE] });
      }
      if (path === "/partner/onboarding" && method === "POST") {
        const b = body() as {
          regionId: string;
          categoryId: string;
          name: { uk: string };
          organizationName?: string;
        };
        if (b.regionId !== REGION_ID) return error(route, 404, "NOT_FOUND");
        if (b.categoryId !== CATEGORY.id)
          return error(route, 422, "UNPROCESSABLE", "errors.partner.categoryNotInTemplate");
        state.orgs.push({ id: ORG_ID, name: b.organizationName ?? b.name.uk, role: "ORG_OWNER" });
        const place: PlaceState = {
          id: PLACE_ID,
          orgId: ORG_ID,
          role: "ORG_OWNER",
          status: "draft",
          name: b.name,
          address: null,
          description: null,
          phone: null,
          weekly: [],
          media: [],
          moderation: null,
          version: 0,
        };
        state.places.push(place);
        return json(route, { organization: {}, place: placeDto(place) }, 201);
      }
      if (path === `/partner/invites/${INVITE_TOKEN}` && method === "GET")
        return json(route, {
          organizationName: "Садиба «Під Смерекою»",
          placeNames: [{ uk: "Садиба «Під Смерекою»" }],
          role: "ORG_STAFF",
          state: state.acceptedInvite ? "accepted" : "active",
          expiresAt: "2026-11-05T00:00:00Z",
          alreadyMember: state.acceptedInvite,
        });
      if (path === `/partner/invites/${INVITE_TOKEN}/accept` && method === "POST") {
        if (state.acceptedInvite) return error(route, 409, "CONFLICT", "errors.staffInvite.used");
        state.acceptedInvite = true;
        state.orgs.push({ id: INVITED_ORG_ID, name: "Садиба «Під Смерекою»", role: "ORG_STAFF" });
        state.places.push({
          id: INVITED_PLACE_ID,
          orgId: INVITED_ORG_ID,
          role: "ORG_STAFF",
          status: "published",
          name: { uk: "Садиба «Під Смерекою»" },
          address: { uk: "Косів" },
          description: null,
          phone: "+380501112233",
          weekly: [],
          media: [],
          moderation: null,
          version: 0,
        });
        return json(
          route,
          { organizationId: INVITED_ORG_ID, regionId: REGION_ID, role: "ORG_STAFF", assignmentId: "a2" },
          201,
        );
      }
      if (path.startsWith("/partner/invites/")) return error(route, 404, "NOT_FOUND");

      const m = /^\/partner\/places\/([^/]+)(\/.*)?$/.exec(path);
      const place = m ? state.places.find((p) => p.id === m[1]) : undefined;
      if (m && !place) return error(route, 404, "NOT_FOUND");
      if (place) {
        const sub = m![2] ?? "";
        if (sub === "" && method === "GET") return json(route, placeDto(place));
        if (sub === "" && method === "PATCH") {
          const b = body() as Partial<PlaceState>;
          if (place.role !== "ORG_OWNER" && (b.name || b.address))
            return error(route, 403, "FORBIDDEN", "errors.forbidden");
          Object.assign(place, b);
          place.version += 1;
          return json(route, placeDto(place));
        }
        if (sub === "/schedule" && method === "PUT") {
          place.weekly = (body() as { weekly: PlaceState["weekly"] }).weekly;
          place.version += 1;
          return route.fulfill({ status: 204, headers: cors });
        }
        if (sub === "/media/uploads" && method === "POST") {
          state.uploads += 1;
          const id = `00000000-0000-4000-8000-00000000e00${state.uploads}`;
          return json(
            route,
            {
              asset: { id },
              upload: {
                url: `https://upload.example/${id}`,
                method: "PUT",
                headers: {},
                expiresAt: "2099-01-01T00:00:00Z",
              },
            },
            201,
          );
        }
        const confirm = /^\/media\/([^/]+)\/confirm$/.exec(sub);
        if (confirm && method === "POST") {
          place.media.push(confirm[1]!);
          place.version += 1;
          return json(route, {}, 201);
        }
        if (sub === "/submit" && method === "POST") {
          const b = body() as { acceptTerms?: boolean; note?: string };
          if (!b.acceptTerms) return error(route, 422, "UNPROCESSABLE", "errors.partner.termsRequired");
          const fields = missing(place);
          if (fields.length)
            return error(route, 422, "UNPROCESSABLE", "errors.partner.requiredFieldsMissing", {
              missingFields: fields,
            });
          state.submitNote = b.note ?? null;
          place.status = "pending_moderation";
          place.moderation = {
            caseId: "00000000-0000-4000-8000-00000000f101",
            status: "open",
            decision: null,
            comment: null,
            submittedAt: "2026-11-02T10:00:00Z",
            decidedAt: null,
          };
          return json(route, placeDto(place), 201);
        }
        if (sub === "/offers" && method === "GET") return json(route, { items: [] });
      }
      return error(route, 404, "NOT_FOUND");
    },
  );
}
