// Адаптер кабинета партнёра (блок 6, ADR-0021) поверх @tg/api-client: /partner/* — сессия Telegram, права —
// назначения ORG_* на сервере. Ошибки — как у блока 5 (ok из host-api): 404/401/409 — свои классы.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import { ok } from "../host/host-api.js";
import { ApiCallError, NetworkError } from "../host/types.js";

export type PartnerMe = ApiSchemas["PartnerMeDto"];
export type PartnerOrganization = ApiSchemas["PartnerOrganizationDto"];
export type PartnerPlaceSummary = ApiSchemas["PartnerPlaceSummaryDto"];
export type PartnerPlace = ApiSchemas["PartnerPlaceDto"];
export type PartnerTemplate = ApiSchemas["PartnerTemplateDto"];
export type PartnerField = ApiSchemas["PartnerPlaceField"];
export type PlaceStatus = ApiSchemas["PlaceStatus"];
export type PlacePatch = ApiSchemas["UpdatePartnerPlaceDto"];
export type Schedule = ApiSchemas["PutScheduleDto"];
export type Offer = ApiSchemas["OfferDto"];
export type OfferInput = ApiSchemas["CreateOfferDto"];
export type PartnerStaff = ApiSchemas["PartnerStaffDto"];
export type StaffInviteRole = ApiSchemas["StaffInviteRole"];
export type StaffInviteCreated = ApiSchemas["StaffInviteCreatedDto"];
export type StaffInvitePreview = ApiSchemas["StaffInvitePreviewDto"];
export type StaffInviteAccepted = ApiSchemas["StaffInviteAcceptedDto"];
export type PartnerRole = ApiSchemas["PartnerRole"];
export type PlaceClaim = ApiSchemas["PlaceClaimDto"];
export type PlaceClaimInput = ApiSchemas["CreatePlaceClaimDto"];
export type PlaceClaimRole = ApiSchemas["PlaceClaimRole"];
export type PlaceClaimStatus = ApiSchemas["PlaceClaimStatus"];
export type PriceList = ApiSchemas["PartnerPriceListDto"];
export type PriceSection = ApiSchemas["PartnerPriceSectionDto"];
export type PriceItem = ApiSchemas["PartnerPriceItemDto"];
export type PriceItemInput = ApiSchemas["CreatePriceItemDto"];
export type PriceItemPatch = ApiSchemas["UpdatePriceItemDto"];
export type PriceSectionPatch = ApiSchemas["UpdatePriceSectionDto"];
export type MoveDirection = ApiSchemas["PriceListMoveDirection"];

/** Префикс start_param приглашения (STAFF_INVITE_START_PREFIX сервера). */
export const INVITE_PREFIX = "inv_";
/** Токен приглашения: base64url 32 байт (INVITE_TOKEN_RE сервера). */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Токен из start_param `inv_<…>` (любой с префиксом — приглашение, не QR: в GET /context не уходит; неверный
 * токен P14 покажет как «не знайдено»); иначе undefined.
 */
export function inviteTokenOf(startParam: string | null | undefined): string | undefined {
  if (!startParam?.startsWith(INVITE_PREFIX)) return undefined;
  return startParam.slice(INVITE_PREFIX.length);
}

/**
 * Повтор с тем же ключом идемпотентности имеет смысл: исход неизвестен (сеть, 5xx, 408, 429 — как isTransient сервера) или запрос с этим ключом
 * ещё выполняется. Иначе (4xx) сервер сохранил ответ — повтор вернёт его же, нужен новый ключ.
 */
export function keepsIdempotencyKey(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (!(err instanceof ApiCallError)) return false;
  return (
    err.status >= 500 || err.status === 429 || err.status === 408 || err.code === "IDEMPOTENCY_IN_PROGRESS"
  );
}

/** Хранилище отклонило PUT файла (истёкшая или неверная подпись, 4xx/5xx) — не сетевая ошибка. */
export class UploadRejectedError extends Error {
  constructor(public readonly status: number) {
    super("upload_rejected");
  }
}

export type PartnerApi = {
  me(): Promise<PartnerMe>;
  templates(regionId: string): Promise<PartnerTemplate[]>;
  onboard(input: ApiSchemas["PartnerOnboardingDto"], idempotencyKey: string): Promise<PartnerPlace>;
  place(id: string): Promise<PartnerPlace>;
  updatePlace(id: string, patch: PlacePatch): Promise<PartnerPlace>;
  putSchedule(id: string, schedule: Schedule): Promise<void>;
  /** Заявка → PUT файла по подписанной ссылке → подтверждение. */
  uploadPhoto(id: string, file: File, alt: string): Promise<void>;
  deletePhoto(id: string, assetId: string): Promise<void>;
  submit(id: string, note: string): Promise<PartnerPlace>;
  /** «Видалити чернетку»: только ни разу не публиковавшееся (place.deletable), иначе 409. */
  deletePlace(id: string): Promise<void>;
  offers(placeId: string): Promise<Offer[]>;
  createOffer(placeId: string, input: OfferInput): Promise<Offer>;
  updateOffer(placeId: string, offerId: string, input: OfferInput): Promise<Offer>;
  archiveOffer(placeId: string, offerId: string): Promise<Offer>;
  /** Прайс (миграция 0030): каждое изменение возвращает прайс целиком. */
  priceList(placeId: string): Promise<PriceList>;
  createPriceSection(placeId: string, title: { uk: string; en?: string }): Promise<PriceList>;
  updatePriceSection(placeId: string, sectionId: string, patch: PriceSectionPatch): Promise<PriceList>;
  movePriceSection(placeId: string, sectionId: string, direction: MoveDirection): Promise<PriceList>;
  archivePriceSection(placeId: string, sectionId: string): Promise<PriceList>;
  createPriceItem(placeId: string, input: PriceItemInput): Promise<PriceList>;
  updatePriceItem(placeId: string, itemId: string, patch: PriceItemPatch): Promise<PriceList>;
  movePriceItem(placeId: string, itemId: string, direction: MoveDirection): Promise<PriceList>;
  archivePriceItem(placeId: string, itemId: string): Promise<PriceList>;
  staff(orgId: string): Promise<PartnerStaff>;
  invite(orgId: string, role: StaffInviteRole): Promise<StaffInviteCreated>;
  revokeInvite(orgId: string, inviteId: string): Promise<void>;
  changeRole(orgId: string, assignmentId: string, role: StaffInviteRole): Promise<void>;
  deactivate(orgId: string, assignmentId: string): Promise<void>;
  invitePreview(token: string): Promise<StaffInvitePreview>;
  acceptInvite(token: string): Promise<StaffInviteAccepted>;
  /** «Це мій заклад» (0031): мои заявки в регионе (новые сверху). */
  claims(regionId: string): Promise<PlaceClaim[]>;
  createClaim(input: PlaceClaimInput, idempotencyKey: string): Promise<PlaceClaim>;
  /** Отозвать свою заявку на рассмотрении. */
  withdrawClaim(id: string): Promise<PlaceClaim>;
};

/** Ответ без тела (204): ok() ждёт data — проверяем статус сами, ошибки — через ok(). */
async function empty(p: Promise<{ data?: unknown; error?: unknown; response: Response }>): Promise<void> {
  const res = await p.catch(() => {
    throw new NetworkError();
  });
  if (res.response.ok) return;
  await ok(Promise.resolve({ ...res, data: undefined }));
}

export function createPartnerApi(api: ApiClient): PartnerApi {
  const place = (id: string) => ({ params: { path: { id } } });
  const offer = (id: string, offerId: string) => ({ params: { path: { id, offerId } } });
  const section = (id: string, sectionId: string) => ({ params: { path: { id, sectionId } } });
  const item = (id: string, itemId: string) => ({ params: { path: { id, itemId } } });
  return {
    me: () => ok(api.GET("/partner/me")),
    templates: async (regionId) =>
      (await ok(api.GET("/partner/templates", { params: { query: { regionId } } }))).items,
    onboard: async (body, key) =>
      (await ok(api.POST("/partner/onboarding", { params: { header: { "Idempotency-Key": key } }, body })))
        .place,
    place: (id) => ok(api.GET("/partner/places/{id}", place(id))),
    updatePlace: (id, body) => ok(api.PATCH("/partner/places/{id}", { ...place(id), body })),
    putSchedule: (id, body) => empty(api.PUT("/partner/places/{id}/schedule", { ...place(id), body })),
    uploadPhoto: async (id, file, alt) => {
      const { asset, upload } = await ok(
        api.POST("/partner/places/{id}/media/uploads", {
          ...place(id),
          body: { mime: file.type, size: file.size, ...(alt ? { alt: { uk: alt } } : {}) },
        }),
      );
      let put: Response;
      try {
        put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
      } catch {
        throw new NetworkError();
      }
      if (!put.ok) throw new UploadRejectedError(put.status);
      await empty(
        api.POST("/partner/places/{id}/media/{assetId}/confirm", {
          params: { path: { id, assetId: asset.id } },
          body: {},
        }),
      );
    },
    deletePhoto: (id, assetId) =>
      empty(api.DELETE("/partner/places/{id}/media/{assetId}", { params: { path: { id, assetId } } })),
    deletePlace: (id) => empty(api.DELETE("/partner/places/{id}", place(id))),
    submit: (id, note) =>
      ok(
        api.POST("/partner/places/{id}/submit", {
          ...place(id),
          body: { acceptTerms: true, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    offers: async (id) => (await ok(api.GET("/partner/places/{id}/offers", place(id)))).items,
    createOffer: (id, body) => ok(api.POST("/partner/places/{id}/offers", { ...place(id), body })),
    updateOffer: (id, offerId, body) =>
      ok(api.PATCH("/partner/places/{id}/offers/{offerId}", { ...offer(id, offerId), body })),
    archiveOffer: (id, offerId) =>
      ok(api.POST("/partner/places/{id}/offers/{offerId}/archive", offer(id, offerId))),
    priceList: (id) => ok(api.GET("/partner/places/{id}/price-list", place(id))),
    createPriceSection: (id, title) =>
      ok(
        api.POST("/partner/places/{id}/price-list/sections", {
          ...place(id),
          body: { title },
        }),
      ),
    updatePriceSection: (id, sectionId, body) =>
      ok(
        api.PATCH("/partner/places/{id}/price-list/sections/{sectionId}", {
          ...section(id, sectionId),
          body,
        }),
      ),
    movePriceSection: (id, sectionId, direction) =>
      ok(
        api.POST("/partner/places/{id}/price-list/sections/{sectionId}/move", {
          ...section(id, sectionId),
          body: { direction },
        }),
      ),
    archivePriceSection: (id, sectionId) =>
      ok(api.POST("/partner/places/{id}/price-list/sections/{sectionId}/archive", section(id, sectionId))),
    createPriceItem: (id, body) =>
      ok(api.POST("/partner/places/{id}/price-list/items", { ...place(id), body })),
    updatePriceItem: (id, itemId, body) =>
      ok(api.PATCH("/partner/places/{id}/price-list/items/{itemId}", { ...item(id, itemId), body })),
    movePriceItem: (id, itemId, direction) =>
      ok(
        api.POST("/partner/places/{id}/price-list/items/{itemId}/move", {
          ...item(id, itemId),
          body: { direction },
        }),
      ),
    archivePriceItem: (id, itemId) =>
      ok(api.POST("/partner/places/{id}/price-list/items/{itemId}/archive", item(id, itemId))),
    staff: (orgId) => ok(api.GET("/partner/organizations/{orgId}/staff", { params: { path: { orgId } } })),
    invite: (orgId, role) =>
      ok(
        api.POST("/partner/organizations/{orgId}/staff/invites", {
          params: { path: { orgId } },
          body: { role },
        }),
      ),
    revokeInvite: (orgId, inviteId) =>
      empty(
        api.DELETE("/partner/organizations/{orgId}/staff/invites/{inviteId}", {
          params: { path: { orgId, inviteId } },
        }),
      ),
    changeRole: (orgId, assignmentId, role) =>
      empty(
        api.PATCH("/partner/organizations/{orgId}/staff/{assignmentId}", {
          params: { path: { orgId, assignmentId } },
          body: { role },
        }),
      ),
    deactivate: (orgId, assignmentId) =>
      empty(
        api.DELETE("/partner/organizations/{orgId}/staff/{assignmentId}", {
          params: { path: { orgId, assignmentId } },
        }),
      ),
    invitePreview: (token) => ok(api.GET("/partner/invites/{token}", { params: { path: { token } } })),
    acceptInvite: (token) => ok(api.POST("/partner/invites/{token}/accept", { params: { path: { token } } })),
    claims: async (regionId) =>
      (await ok(api.GET("/partner/claims", { params: { query: { regionId } } }))).items,
    withdrawClaim: (id) => ok(api.POST("/partner/claims/{id}/withdraw", { params: { path: { id } } })),
    createClaim: (body, key) =>
      ok(api.POST("/partner/claims", { params: { header: { "Idempotency-Key": key } }, body })),
  };
}
