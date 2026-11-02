import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  currentDb,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type JsonObject,
  type Offer,
  type OfferStatus,
  type PartnerModule,
  type PartnerTemplate,
  type StaffInvite,
  type StaffInviteRole,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import {
  CatalogRepository,
  CatalogService,
  placeInput,
  rethrowCatalogError,
  scheduleInput,
  toPlaceMediaDto,
  toScheduleDto,
  type PlaceRecord,
  type PutScheduleDto,
} from "../catalog/index.js";
import { NotificationsService, type NotificationDraft } from "../host/index.js";
import { MediaError, MediaService, toMediaAssetDto, type MediaUploadDto } from "../media/index.js";
import {
  chainRegionId,
  findGrant,
  isGrantActive,
  RbacService,
  scope,
  ScopeHierarchy,
  type Grant,
  type PermissionCode,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { RoleAssignmentError, RoleAssignmentService } from "../role-assignments/index.js";
import {
  abilitiesOf,
  higherRole,
  inviteState,
  isPartnerEditable,
  isPartnerRole,
  isSubmittable,
  missingFields,
  normalizeInviteToken,
  changedIdentityFields,
  IDENTITY_FIELDS,
  touchedIdentityFields,
  validOfferPeriod,
} from "./partner-rules.js";
import {
  STAFF_INVITE_START_PREFIX,
  STAFF_INVITE_TTL_HOURS,
  type CreateOfferDto,
  type OfferDto,
  type OfferListDto,
  type PartnerCategoryDto,
  type PartnerMediaConfirmDto,
  type PartnerMediaUploadRequestDto,
  type PartnerMeDto,
  type PartnerModerationSummaryDto,
  type PartnerOnboardingDto,
  type PartnerOnboardingResultDto,
  type PartnerOrganizationDto,
  type PartnerPlaceDto,
  type PartnerRole,
  type PartnerStaffDto,
  type PartnerStaffMemberDto,
  type PartnerSubmitDto,
  type PartnerTemplateListDto,
  type StaffInviteAcceptedDto,
  type StaffInviteCreatedDto,
  type StaffInviteDto,
  type StaffInvitePreviewDto,
  type UpdateOfferDto,
  type UpdatePartnerPlaceDto,
} from "./partner.dto.js";
import { PARTNER_OPTIONS, type PartnerModuleOptions } from "./partner.options.js";
import { PartnerRepository, type CategoryRef, type StaffMemberRow } from "./partner.repository.js";

export type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

export const PARTNER_AUDIT = {
  organizationCreate: "organization.create",
  placeCreate: "place.create",
  submit: "place.submit",
  inviteCreate: "staff_invite.create",
  inviteRevoke: "staff_invite.revoke",
  inviteAccept: "staff_invite.accept",
  offerCreate: "offer.create",
  offerUpdate: "offer.update",
  offerArchive: "offer.archive",
} as const;

export const MODERATION_CASE_ENTITY = "moderation_case";
/** Версия условий для партнёров, с которыми соглашаются при отправке на модерацию (acceptTerms). */
export const PARTNER_TERMS_VERSION = "2026-11-02";
/** organizations.name: 1–200 символов (CHECK 0017); название места может быть до 300 — обрезаем по кодпоинтам. */
export const ORGANIZATION_NAME_MAX = 200;

export function organizationName(raw: string): string {
  return Array.from(raw.trim()).slice(0, ORGANIZATION_NAME_MAX).join("").trim();
}
export const NOTIFICATION_TEMPLATE_CASE_OPENED = "moderation.case_opened";

/** Доступ к месту партнёра: организация и регион — из иерархии на сервере; назначение — в аудит. */
type PlaceAccess = {
  placeId: string;
  organizationId: string;
  regionId: string;
  role: PartnerRole;
  grantId: string;
};
type OrgAccess = { organizationId: string; regionId: string; role: PartnerRole; grantId: string };

const notFound = () => new ApiError("NOT_FOUND");
const forbidden = (reason: string) => new ApiError("FORBIDDEN", { details: { reason } });
const notEditable = (status: string) =>
  new ApiError("CONFLICT", {
    messageKey: "errors.partner.placeNotEditable",
    details: { reason: "not_editable", status },
  });

const sha256 = (token: string) => createHash("sha256").update(token, "utf8").digest();

/**
 * Кабинет партнёра (блок 6; S-05, S-06; P01, P06, P07, P09, P12–P14; ADR-0021). Сессия Telegram (как /me);
 * права — назначения ORG_* на организацию, область объекта (место → организация → регион) — из БД на сервере.
 * Каждое действие — в транзакции региона организации (withTenant) с записью AuditLog; уведомления ботом — после
 * коммита.
 */
@Injectable()
export class PartnerService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PartnerRepository) private readonly repo: PartnerRepository,
    @Inject(CatalogRepository) private readonly catalogRepo: CatalogRepository,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(ScopeHierarchy) private readonly hierarchy: ScopeHierarchy,
    @Inject(RoleAssignmentService) private readonly roles: RoleAssignmentService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(MediaService) private readonly media: MediaService,
    @Optional() @Inject(PARTNER_OPTIONS) private readonly options: PartnerModuleOptions = {},
  ) {}

  /** Часы сервиса (подменяется в тестах). */
  now: () => Date = () => new Date();

  // --- шаблоны и онбординг (P12) ---

  async templates(regionId: string): Promise<PartnerTemplateListDto> {
    const region = await this.activeRegion(regionId);
    return withTenant(this.db, regionContext(region), async () => {
      const templates = await this.repo.listTemplates();
      const categories = await this.repo.categoriesByCodes([
        ...new Set(templates.flatMap((t) => t.category_codes)),
      ]);
      return {
        items: templates.map((t) => ({
          id: t.id,
          code: t.code,
          name: t.name_i18n,
          description: t.description_i18n,
          requiredFields: t.required_fields,
          modules: t.modules,
          categories: templateCategories(t, categories),
        })),
      };
    });
  }

  /**
   * S-05 п. 2: Organization + Place(draft) по шаблону + ORG_OWNER на организацию. Назначение пишет сервис ролей от
   * имени SYSTEM (у пользователя ещё нет назначения, которым он мог бы назначать), действие пользователя — запись
   * organization.create с его актором.
   */
  async onboard(
    userId: string,
    input: PartnerOnboardingDto,
    meta: AuditMeta,
  ): Promise<PartnerOnboardingResultDto> {
    const regionId = await this.activeRegion(input.regionId);
    const { placeId } = await withTenant(this.db, regionContext(regionId), async (trx) => {
      const template = await this.repo.findTemplateByCode(input.templateCode);
      if (!template)
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.partner.templateUnavailable",
          details: { reason: "template_unavailable" },
        });
      const category = await this.catalogRepo.findCategory(input.categoryId.toLowerCase());
      if (!category?.active || !template.category_codes.includes(category.code))
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.partner.categoryNotInTemplate",
          details: { reason: "category_not_in_template", allowed: template.category_codes },
        });
      const name = { ...input.name, uk: input.name.uk.trim() };
      const org = await this.repo.createOrganization({
        name: organizationName(input.organizationName ?? name.uk),
        created_by: userId,
      });
      const place = await this.catalogRepo.createPlace({
        category_id: category.id,
        name_i18n: name,
        organization_id: org.id,
        partner_template_id: template.id,
        created_by: userId,
      });
      const grant = await this.roles.assign(trx, {
        userId,
        role: "ORG_OWNER",
        scope: scope("ORGANIZATION", org.id),
        actor: { type: "system" },
        reason: "partner_onboarding",
        requestId: meta.requestId ?? null,
      });
      await this.record(meta, grant.id, {
        action: PARTNER_AUDIT.organizationCreate,
        entityType: "organization",
        entityId: org.id,
        newValues: { name: org.name, ownerAssignmentId: grant.id },
        regionId,
      });
      await this.record(meta, grant.id, {
        action: PARTNER_AUDIT.placeCreate,
        entityType: "place",
        entityId: place.id,
        newValues: {
          status: place.status,
          organizationId: org.id,
          template: template.code,
          categoryId: category.id,
          name: place.name_i18n,
        },
        regionId,
      });
      return { placeId: place.id };
    });
    const me = await this.me(userId);
    const organization = me.organizations.find((o) => o.places.some((p) => p.id === placeId));
    if (!organization) throw new Error("Организация не найдена после онбординга");
    return { organization, place: await this.getPlace(userId, placeId) };
  }

  // --- режим партнёра (P13, P01) ---

  async me(userId: string): Promise<PartnerMeDto> {
    const orgs = await this.orgAccesses(userId);
    const out: PartnerOrganizationDto[] = [];
    for (const [regionId, list] of groupBy(orgs, (o) => o.regionId))
      await withTenant(this.db, regionContext(regionId), async () => {
        const ids = list.map((o) => o.organizationId);
        const [rows, places] = await Promise.all([this.repo.organizations(ids), this.repo.placesOf(ids)]);
        const placeIds = places.map((p) => p.id);
        const hostIds = places.filter((p) => p.template_modules?.includes("host_requests")).map((p) => p.id);
        const [cases, requests, offers] = await Promise.all([
          this.repo.lastCases(placeIds),
          this.repo.openRequestCounts(hostIds),
          this.repo.activeOfferCounts(placeIds),
        ]);
        for (const access of list) {
          const org = rows.find((r) => r.id === access.organizationId);
          if (!org) continue;
          out.push({
            id: org.id,
            regionId,
            name: org.name,
            role: access.role,
            assignmentId: access.grantId,
            abilities: abilitiesOf(access.role),
            places: places
              .filter((p) => p.organization_id === org.id)
              .map((p) => {
                const modules = (p.template_modules ?? []) as PartnerModule[];
                const c = cases.get(p.id);
                return {
                  id: p.id,
                  name: p.name_i18n,
                  status: p.status,
                  templateCode: p.template_code,
                  modules,
                  moderation: c ? toModerationSummary(c) : null,
                  openServiceRequests: modules.includes("host_requests") ? (requests.get(p.id) ?? 0) : null,
                  activeOffers: offers.get(p.id) ?? 0,
                };
              }),
          });
        }
      });
    out.sort((a, b) => a.name.localeCompare(b.name, "uk") || a.id.localeCompare(b.id));
    return { organizations: out };
  }

  // --- редактор заведения (P06) ---

  async getPlace(userId: string, placeId: string): Promise<PartnerPlaceDto> {
    const access = await this.placeAccess(userId, placeId, "place.edit");
    return withTenant(this.db, regionContext(access.regionId), () => this.placeDto(access));
  }

  async updatePlace(
    userId: string,
    placeId: string,
    input: UpdatePartnerPlaceDto,
    meta: AuditMeta,
  ): Promise<PartnerPlaceDto> {
    const access = await this.placeAccess(userId, placeId, "place.edit");
    // Право на поля личности (place.submit) — только если они переданы; запрещено лишь их реальное изменение.
    const canIdentity =
      touchedIdentityFields(input as Record<string, unknown>).length > 0 &&
      (await this.placeAccess(userId, placeId, "place.submit").then(
        () => true,
        () => false,
      ));
    return this.inPlace(access, async (place, template) => {
      const identity = changedIdentityFields(input, {
        categoryId: place.category_id,
        localityId: place.locality_id,
        name: place.name_i18n,
        address: place.address_i18n,
        location: place.location,
      });
      if (identity.length > 0 && !canIdentity)
        throw new ApiError("FORBIDDEN", {
          details: { reason: "identity_fields_forbidden", identityFields: identity },
        });
      if (!isPartnerEditable(place.status)) throw notEditable(place.status);
      // Опубликованное место: поля личности — только через админа региона (без PlaceRevision, §1.6), иначе
      // модерацию можно было бы обойти правкой после одобрения.
      if (place.status === "published" && identity.length > 0)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.partner.identityChangeRequiresModeration",
          details: { reason: "identity_change_requires_moderation", identityFields: identity },
        });
      // Переданные без изменения поля личности не пишутся (форма целиком; пробелы по краям не меняют название).
      const patch = { ...input, verifiedAt: undefined };
      for (const f of IDENTITY_FIELDS) if (!identity.includes(f)) delete patch[f];
      if (patch.categoryId !== undefined) await this.checkTemplateCategory(template, patch.categoryId);
      await this.catalog
        .updatePlace(this.meta(meta, access), placeId, placeInput(patch))
        .catch(rethrowCatalogError);
      return this.placeDto(access);
    });
  }

  async putSchedule(
    userId: string,
    placeId: string,
    input: PutScheduleDto,
    meta: AuditMeta,
  ): Promise<PartnerPlaceDto> {
    const access = await this.placeAccess(userId, placeId, "schedule.edit");
    return this.inPlace(access, async (place) => {
      if (!isPartnerEditable(place.status)) throw notEditable(place.status);
      await this.catalog
        .replaceSchedule(this.meta(meta, access), placeId, scheduleInput(input))
        .catch(rethrowCatalogError);
      return this.placeDto(access);
    });
  }

  async createMediaUpload(
    userId: string,
    placeId: string,
    input: PartnerMediaUploadRequestDto,
  ): Promise<MediaUploadDto> {
    const access = await this.placeAccess(userId, placeId, "media.upload");
    return this.inPlace(access, async (place) => {
      if (!isPartnerEditable(place.status)) throw notEditable(place.status);
      const { asset, upload } = await this.media
        .createUpload({
          regionId: access.regionId,
          ownerType: "place",
          ownerId: placeId,
          kind: "image",
          mime: input.mime,
          size: input.size,
          alt: input.alt ? { ...input.alt } : null,
          createdBy: userId,
        })
        .catch(rethrowMediaError);
      return {
        asset: toMediaAssetDto(asset),
        upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
      };
    });
  }

  async confirmMedia(
    userId: string,
    placeId: string,
    assetId: string,
    input: PartnerMediaConfirmDto,
    meta: AuditMeta,
  ): Promise<PartnerPlaceDto> {
    const access = await this.placeAccess(userId, placeId, "media.upload");
    return this.inPlace(access, async (place) => {
      if (!isPartnerEditable(place.status)) throw notEditable(place.status);
      const id = assetId.toLowerCase();
      const before = await this.media.find(id);
      if (before?.owner_type !== "place" || before.owner_id !== placeId) throw notFound();
      const asset = await this.media.confirm(id).catch(rethrowMediaError);
      if (!asset) throw notFound();
      if (asset.status === "rejected")
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.place.mediaInvalid",
          details: { reason: "media_rejected", rejectReason: asset.reject_reason },
        });
      const linked = (await this.catalogRepo.placeMedia(placeId)).some((m) => m.media_asset_id === id);
      const mediaInput = { alt: input.alt ? { ...input.alt } : undefined, isCover: input.isCover };
      const auditMeta = this.meta(meta, access);
      await (
        linked
          ? this.catalog.updateMedia(auditMeta, placeId, id, mediaInput)
          : this.catalog.attachMedia(auditMeta, placeId, id, mediaInput)
      ).catch(rethrowCatalogError);
      return this.placeDto(access);
    });
  }

  async deleteMedia(userId: string, placeId: string, assetId: string, meta: AuditMeta): Promise<void> {
    const access = await this.placeAccess(userId, placeId, "media.upload");
    await this.inPlace(access, async (place) => {
      if (!isPartnerEditable(place.status)) throw notEditable(place.status);
      await this.catalog
        .detachMedia(this.meta(meta, access), placeId, assetId.toLowerCase())
        .catch(rethrowCatalogError);
    });
  }

  /**
   * «Надіслати на модерацію» (S-05 п. 4): обязательные поля шаблона, готовность к публикации (правила каталога),
   * согласие с условиями → pending_moderation и ModerationCase со снимком карточки; модераторам региона — бот.
   */
  async submit(
    userId: string,
    placeId: string,
    input: PartnerSubmitDto,
    meta: AuditMeta,
  ): Promise<PartnerPlaceDto> {
    const access = await this.placeAccess(userId, placeId, "place.submit");
    if (!input.acceptTerms)
      throw new ApiError("UNPROCESSABLE", {
        messageKey: "errors.partner.termsRequired",
        details: { reason: "terms_required" },
      });
    const acceptedAt = this.now();
    const { dto, notify } = await this.inPlace(access, async (place) => {
      if (!isSubmittable(place.status)) throw notEditable(place.status);
      const before = await this.placeDto(access);
      if (before.missingFields.length > 0)
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.partner.requiredFieldsMissing",
          details: { reason: "required_fields_missing", missingFields: before.missingFields },
        });
      const problems = await this.catalog.publishCheck(placeId).catch(rethrowCatalogError);
      if (problems.length > 0)
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.place.notPublishable",
          details: { reason: "not_publishable", problems: [...problems] },
        });
      const created = await this.repo
        .insertCase({
          place_id: placeId,
          organization_id: access.organizationId,
          submitted_by: userId,
          partner_note: input.note?.trim() || null,
          place_snapshot: {
            ...placeSnapshot(before),
            terms: { version: PARTNER_TERMS_VERSION, acceptedAt: acceptedAt.toISOString() },
          },
        })
        .catch((e: unknown) => {
          if (isUniqueViolation(e, "moderation_cases_open_key")) throw notEditable("pending_moderation");
          throw e;
        });
      await this.catalogRepo.updatePlace(placeId, { status: "pending_moderation" });
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.submit,
        entityType: "place",
        entityId: placeId,
        oldValues: { status: place.status },
        newValues: {
          status: "pending_moderation",
          caseId: created.id,
          termsVersion: PARTNER_TERMS_VERSION,
          termsAcceptedAt: acceptedAt.toISOString(),
        },
        regionId: access.regionId,
      });
      const moderators = (await this.repo.regionModerators(access.regionId)).filter((u) => u !== userId);
      const notify = await this.notifications.enqueue(
        moderators.map(
          (u): NotificationDraft => ({
            recipientUserId: u,
            template: NOTIFICATION_TEMPLATE_CASE_OPENED,
            entityType: MODERATION_CASE_ENTITY,
            entityId: created.id,
            body: `Нова заявка на модерацію: «${before.name.uk}» (${before.template.name.uk}).`,
          }),
        ),
      );
      return { dto: await this.placeDto(access), notify };
    });
    this.notifications.dispatchInBackground(access.regionId, notify);
    return dto;
  }

  // --- акции (P07) ---

  async listOffers(userId: string, placeId: string, status?: OfferStatus): Promise<OfferListDto> {
    const access = await this.placeAccess(userId, placeId, "offer.manage");
    return withTenant(this.db, regionContext(access.regionId), async () => ({
      items: (await this.repo.offers(placeId, status)).map(toOfferDto),
    }));
  }

  async createOffer(
    userId: string,
    placeId: string,
    input: CreateOfferDto,
    meta: AuditMeta,
  ): Promise<OfferDto> {
    const access = await this.placeAccess(userId, placeId, "offer.manage");
    checkPeriod(input.startsAt ?? null, input.endsAt ?? null);
    return this.inPlace(access, async (place) => {
      if (place.status === "archived") throw notEditable(place.status);
      const offer = await this.repo.createOffer({
        place_id: placeId,
        title_i18n: { ...input.title },
        description_i18n: input.description ? { ...input.description } : null,
        starts_at: input.startsAt ?? null,
        ends_at: input.endsAt ?? null,
        created_by: userId,
      });
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.offerCreate,
        entityType: "offer",
        entityId: offer.id,
        newValues: offerSnapshot(offer),
        regionId: access.regionId,
      });
      return toOfferDto(offer);
    });
  }

  async updateOffer(
    userId: string,
    placeId: string,
    offerId: string,
    input: UpdateOfferDto,
    meta: AuditMeta,
  ): Promise<OfferDto> {
    const access = await this.placeAccess(userId, placeId, "offer.manage");
    return this.inPlace(access, async () => {
      const before = await this.repo.findOffer(placeId, offerId.toLowerCase());
      if (!before) throw notFound();
      if (before.status === "archived")
        throw new ApiError("CONFLICT", {
          messageKey: "errors.partner.offerArchived",
          details: { reason: "offer_archived" },
        });
      const startsAt =
        input.startsAt === undefined ? (before.starts_at?.toISOString() ?? null) : input.startsAt;
      const endsAt = input.endsAt === undefined ? (before.ends_at?.toISOString() ?? null) : input.endsAt;
      checkPeriod(startsAt, endsAt);
      const after = await this.repo.updateOffer(before.id, {
        ...(input.title !== undefined ? { title_i18n: { ...input.title } } : {}),
        ...(input.description !== undefined
          ? { description_i18n: input.description ? { ...input.description } : null }
          : {}),
        ...(input.startsAt !== undefined ? { starts_at: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { ends_at: input.endsAt } : {}),
      });
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.offerUpdate,
        entityType: "offer",
        entityId: after.id,
        oldValues: offerSnapshot(before),
        newValues: offerSnapshot(after),
        regionId: access.regionId,
      });
      return toOfferDto(after);
    });
  }

  async archiveOffer(userId: string, placeId: string, offerId: string, meta: AuditMeta): Promise<OfferDto> {
    const access = await this.placeAccess(userId, placeId, "offer.manage");
    return this.inPlace(access, async () => {
      const before = await this.repo.findOffer(placeId, offerId.toLowerCase());
      if (!before) throw notFound();
      if (before.status === "archived") return toOfferDto(before);
      const after = await this.repo.updateOffer(before.id, { status: "archived" });
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.offerArchive,
        entityType: "offer",
        entityId: after.id,
        oldValues: { status: before.status },
        newValues: { status: after.status },
        regionId: access.regionId,
      });
      return toOfferDto(after);
    });
  }

  // --- сотрудники (P09) ---

  async staff(userId: string, organizationId: string): Promise<PartnerStaffDto> {
    const access = await this.orgAccess(userId, organizationId, "staff.invite");
    return withTenant(this.db, regionContext(access.regionId), async () => {
      const [members, invites] = await Promise.all([
        this.repo.staffOf(access.organizationId),
        this.repo.invites(access.organizationId),
      ]);
      const now = this.now();
      return {
        members: members.map((m) => toMember(m, userId)),
        invites: invites.map((i) => toInviteDto(i, now, i.accepted_by_name)),
      };
    });
  }

  async createInvite(
    userId: string,
    organizationId: string,
    role: StaffInviteRole,
    meta: AuditMeta,
  ): Promise<StaffInviteCreatedDto> {
    const access = await this.orgAccess(userId, organizationId, "staff.invite");
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    return withTenant(this.db, regionContext(access.regionId), async () => {
      const invite = await this.repo.createInvite({
        organization_id: access.organizationId,
        role,
        token_hash: sha256(token),
        expires_at: new Date(now.getTime() + STAFF_INVITE_TTL_HOURS * 3600_000),
        created_by: userId,
      });
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.inviteCreate,
        entityType: "staff_invite",
        entityId: invite.id,
        newValues: {
          organizationId: access.organizationId,
          role,
          expiresAt: invite.expires_at.toISOString(),
        },
        regionId: access.regionId,
      });
      const startParam = `${STAFF_INVITE_START_PREFIX}${token}`;
      const bot = this.options.botUsername?.replace(/^@/, "");
      return {
        invite: toInviteDto(invite, now, null),
        token,
        startParam,
        link: bot ? `https://t.me/${bot}?startapp=${startParam}` : null,
      };
    });
  }

  async revokeInvite(
    userId: string,
    organizationId: string,
    inviteId: string,
    meta: AuditMeta,
  ): Promise<void> {
    const access = await this.orgAccess(userId, organizationId, "staff.invite");
    await withTenant(this.db, regionContext(access.regionId), async () => {
      const invite = await this.repo.findInvite(access.organizationId, inviteId.toLowerCase(), true);
      if (!invite) throw notFound();
      if (invite.accepted_at)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.staffInvite.used",
          details: { reason: "used" },
        });
      if (invite.revoked_at) return;
      await this.repo.revokeInvite(invite.id, userId);
      await this.record(meta, access.grantId, {
        action: PARTNER_AUDIT.inviteRevoke,
        entityType: "staff_invite",
        entityId: invite.id,
        oldValues: { state: inviteState(invite, this.now()) },
        newValues: { state: "revoked" },
        regionId: access.regionId,
      });
    });
  }

  /** Смена роли сотрудника: отзыв назначения и новое (назначения неизменяемы); оба шага — AuditLog сервиса ролей. */
  async changeRole(
    userId: string,
    organizationId: string,
    assignmentId: string,
    role: StaffInviteRole,
    meta: AuditMeta,
  ): Promise<PartnerStaffMemberDto> {
    const access = await this.orgAccess(userId, organizationId, "staff.role.assign");
    return withTenant(this.db, regionContext(access.regionId), async (trx) => {
      const member = await this.staffMember(access.organizationId, assignmentId);
      if (member.role === role) return toMember(member, userId);
      await this.roles
        .revoke(trx, {
          assignmentId: member.assignment_id,
          actor: meta.actor,
          actorAssignmentId: access.grantId,
          requestId: meta.requestId ?? null,
          reason: `staff_role_change:${role}`,
        })
        .catch(rethrowRoleError);
      const next = await this.roles
        .assign(trx, {
          userId: member.user_id,
          role,
          scope: scope("ORGANIZATION", access.organizationId),
          actor: meta.actor,
          actorAssignmentId: access.grantId,
          requestId: meta.requestId ?? null,
          reason: `staff_role_change:${member.role}`,
        })
        .catch(rethrowRoleError);
      return toMember(
        { ...member, assignment_id: next.id, role: next.role, granted_at: next.granted_at },
        userId,
      );
    });
  }

  async deactivate(
    userId: string,
    organizationId: string,
    assignmentId: string,
    meta: AuditMeta,
  ): Promise<void> {
    const access = await this.orgAccess(userId, organizationId, "staff.deactivate");
    await withTenant(this.db, regionContext(access.regionId), async (trx) => {
      const member = await this.staffMember(access.organizationId, assignmentId);
      await this.roles
        .revoke(trx, {
          assignmentId: member.assignment_id,
          actor: meta.actor,
          actorAssignmentId: access.grantId,
          requestId: meta.requestId ?? null,
          reason: "staff_deactivate",
        })
        .catch(rethrowRoleError);
    });
  }

  // --- приглашение (P14) ---

  async previewInvite(userId: string, rawToken: string): Promise<StaffInvitePreviewDto> {
    const { regionId, hash } = await this.inviteLocation(rawToken);
    return withTenant(this.db, regionContext(regionId), async () => {
      const invite = await this.repo.findInviteByHash(hash);
      if (!invite) throw notFound();
      const [org, names, member] = await Promise.all([
        this.repo.findOrganization(invite.organization_id),
        this.repo.placeNames(invite.organization_id),
        this.isMember(userId, invite.organization_id),
      ]);
      return {
        organizationName: org?.name ?? "",
        placeNames: names,
        role: invite.role,
        state: inviteState(invite, this.now()),
        expiresAt: invite.expires_at.toISOString(),
        alreadyMember: member,
      };
    });
  }

  /**
   * Принятие (S-06 п. 5): одноразово — приглашение блокируется (FOR UPDATE) и помечается использованным условным
   * UPDATE; назначение роли — сервис ролей от имени SYSTEM (приглашённый ещё без назначений), действие
   * пользователя — запись staff_invite.accept с его актором.
   */
  async acceptInvite(userId: string, rawToken: string, meta: AuditMeta): Promise<StaffInviteAcceptedDto> {
    const { regionId, hash } = await this.inviteLocation(rawToken);
    return withTenant(this.db, regionContext(regionId), async (trx) => {
      const invite = await this.repo.findInviteByHash(hash, true);
      if (!invite) throw notFound();
      const state = inviteState(invite, this.now());
      if (state !== "active")
        throw new ApiError("CONFLICT", {
          messageKey: `errors.staffInvite.${state === "accepted" ? "used" : state}`,
          details: { reason: state === "accepted" ? "used" : state },
        });
      if (await this.isMember(userId, invite.organization_id))
        throw new ApiError("CONFLICT", {
          messageKey: "errors.staffInvite.alreadyMember",
          details: { reason: "already_member" },
        });
      const grant = await this.roles
        .assign(trx, {
          userId,
          role: invite.role,
          scope: scope("ORGANIZATION", invite.organization_id),
          actor: { type: "system" },
          reason: `staff_invite:${invite.id}`,
          requestId: meta.requestId ?? null,
        })
        .catch(rethrowRoleError);
      const accepted = await this.repo.acceptInvite(invite.id, userId, grant.id);
      if (!accepted)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.staffInvite.used",
          details: { reason: "used" },
        });
      await this.record(meta, grant.id, {
        action: PARTNER_AUDIT.inviteAccept,
        entityType: "staff_invite",
        entityId: invite.id,
        oldValues: { state: "active" },
        newValues: { state: "accepted", role: invite.role, assignmentId: grant.id },
        regionId,
      });
      return { organizationId: invite.organization_id, regionId, role: invite.role, assignmentId: grant.id };
    });
  }

  // --- внутреннее ---

  private async activeRegion(regionId: string): Promise<string> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw notFound();
    return region.id;
  }

  /** Назначения ролей партнёра на организации (старшая роль на организацию). */
  private async orgAccesses(userId: string): Promise<OrgAccess[]> {
    const grants = await this.rbac.grantsOf(userId);
    const now = this.now();
    const out = new Map<string, OrgAccess>();
    for (const g of grants) {
      if (g.scopeType !== "ORGANIZATION" || !g.scopeId || !g.regionId) continue;
      if (!isGrantActive(g, now) || !isPartnerRole(g.role)) continue;
      const id = g.scopeId.toLowerCase();
      const prev = out.get(id);
      if (prev && higherRole(prev.role, g.role) === prev.role) continue;
      out.set(id, { organizationId: id, regionId: g.regionId.toLowerCase(), role: g.role, grantId: g.id });
    }
    return [...out.values()];
  }

  private async isMember(userId: string, organizationId: string): Promise<boolean> {
    return (await this.orgAccesses(userId)).some((o) => o.organizationId === organizationId);
  }

  /**
   * Доступ к месту партнёра с правом: место → организация → регион (из БД). Место не найдено или не партнёрское
   * (без организации) — 404; нет роли в организации — 403 not_partner; роль без права — 403 role_forbidden.
   */
  private async placeAccess(
    userId: string,
    placeId: string,
    permission: PermissionCode,
  ): Promise<PlaceAccess> {
    const chain = await this.hierarchy.chain(scope("PLACE", placeId));
    const org = chain?.[1];
    const regionId = chain ? chainRegionId(chain) : null;
    if (!chain || org?.type !== "ORGANIZATION" || !regionId) throw notFound();
    const { access, grants } = await this.partnerRole(userId, org.id);
    const grant = findGrant(grants, permission, chain, this.now());
    if (!grant) throw forbidden("role_forbidden");
    return { ...access, placeId: placeId.toLowerCase(), regionId, grantId: grant.id };
  }

  private async orgAccess(
    userId: string,
    organizationId: string,
    permission: PermissionCode,
  ): Promise<OrgAccess> {
    const chain = await this.hierarchy.chain(scope("ORGANIZATION", organizationId));
    const regionId = chain ? chainRegionId(chain) : null;
    if (!chain || !regionId) throw notFound();
    const { access, grants } = await this.partnerRole(userId, organizationId.toLowerCase());
    const grant = findGrant(grants, permission, chain, this.now());
    if (!grant) throw forbidden("role_forbidden");
    return { ...access, regionId, grantId: grant.id };
  }

  private async partnerRole(
    userId: string,
    organizationId: string,
  ): Promise<{ access: OrgAccess; grants: Grant[] }> {
    const grants = await this.rbac.grantsOf(userId);
    const access = (await this.orgAccesses(userId)).find((o) => o.organizationId === organizationId);
    if (!access) throw forbidden("not_partner");
    return { access, grants };
  }

  /** Транзакция региона места с блокировкой строки места и шаблоном. */
  private inPlace<T>(
    access: PlaceAccess,
    fn: (place: PlaceRecord, template: PartnerTemplate) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.db, regionContext(access.regionId), async () => {
      const place = await this.catalogRepo.lockPlace(access.placeId);
      if (!place?.partner_template_id) throw notFound();
      const template = await this.repo.findTemplate(place.partner_template_id);
      if (!template) throw notFound();
      return fn(place, template);
    });
  }

  private async checkTemplateCategory(template: PartnerTemplate, categoryId: string): Promise<void> {
    const category = await this.catalogRepo.findCategory(categoryId.toLowerCase());
    if (category && !template.category_codes.includes(category.code))
      throw new ApiError("UNPROCESSABLE", {
        messageKey: "errors.partner.categoryNotInTemplate",
        details: { reason: "category_not_in_template", allowed: template.category_codes },
      });
  }

  /** Карточка P06 (в транзакции региона места). */
  private async placeDto(access: PlaceAccess): Promise<PartnerPlaceDto> {
    const place = await this.catalogRepo.findPlace(access.placeId);
    if (!place?.partner_template_id || place.organization_id !== access.organizationId) throw notFound();
    const template = await this.repo.findTemplate(place.partner_template_id);
    if (!template) throw notFound();
    const [tagIds, schedule, media, categories, cases] = await Promise.all([
      this.catalogRepo.placeTagIds(place.id),
      this.catalog.getSchedule(place.id).catch(rethrowCatalogError),
      this.catalogRepo.placeMedia(place.id),
      this.repo.categoriesByCodes(template.category_codes),
      this.repo.lastCases([place.id]),
    ]);
    const preview: Record<string, string> = {};
    for (const m of media.filter((x) => x.status === "ready")) {
      const asset = await this.media.find(m.media_asset_id);
      if (!asset) continue;
      const links = await this.media.links(asset);
      const link = links.find((l) => l.name === "w320") ?? links[0];
      if (link) preview[m.media_asset_id] = link.url;
    }
    const missing = missingFields(template.required_fields, {
      name: place.name_i18n,
      categoryId: place.category_id,
      description: place.description_i18n,
      address: place.address_i18n,
      hasLocation: place.location !== null,
      phone: place.phone,
      weeklyIntervals: schedule.weekly.length,
      photos: media.filter((m) => m.status !== "rejected").length,
    });
    const c = cases.get(place.id);
    return {
      id: place.id,
      organizationId: access.organizationId,
      regionId: access.regionId,
      status: place.status,
      template: {
        code: template.code,
        name: template.name_i18n,
        requiredFields: template.required_fields,
        modules: template.modules,
        categories: templateCategories(template, categories),
      },
      role: access.role,
      abilities: abilitiesOf(access.role),
      editable: isPartnerEditable(place.status),
      categoryId: place.category_id,
      localityId: place.locality_id,
      name: place.name_i18n,
      description: place.description_i18n,
      address: place.address_i18n,
      location: place.location,
      phone: place.phone,
      website: place.website,
      telegram: place.telegram,
      tagIds,
      schedule: toScheduleDto(schedule),
      media: media.map(toPlaceMediaDto),
      mediaPreview: preview,
      missingFields: missing,
      moderation: c ? toModerationSummary(c) : null,
      updatedAt: place.updated_at.toISOString(),
    };
  }

  private async staffMember(organizationId: string, assignmentId: string): Promise<StaffMemberRow> {
    const member = (await this.repo.staffOf(organizationId)).find(
      (m) => m.assignment_id === assignmentId.toLowerCase(),
    );
    if (!member) throw notFound();
    if (member.role === "ORG_OWNER") throw forbidden("owner_protected");
    return member;
  }

  private async inviteLocation(rawToken: string): Promise<{ regionId: string; hash: Buffer }> {
    const token = normalizeInviteToken(rawToken, STAFF_INVITE_START_PREFIX);
    if (!token) throw notFound();
    const hash = sha256(token);
    const regionId = await this.repo.inviteRegion(hash);
    if (!regionId) throw notFound();
    return { regionId, hash };
  }

  private meta(meta: AuditMeta, access: { grantId: string }): AuditMeta {
    return { ...meta, roleAssignmentId: access.grantId };
  }

  private async record(
    meta: AuditMeta,
    grantId: string,
    entry: Omit<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), { ...meta, roleAssignmentId: grantId, ...entry });
  }
}

// --- преобразования ---

function templateCategories(t: PartnerTemplate, categories: readonly CategoryRef[]): PartnerCategoryDto[] {
  return categories
    .filter((c) => t.category_codes.includes(c.code))
    .map((c) => ({ id: c.id, code: c.code, name: c.name_i18n }));
}

export function toModerationSummary(c: {
  id: string;
  status: PartnerModerationSummaryDto["status"];
  decision: PartnerModerationSummaryDto["decision"];
  comment: string | null;
  submitted_at: Date;
  decided_at: Date | null;
}): PartnerModerationSummaryDto {
  return {
    caseId: c.id,
    status: c.status,
    decision: c.decision,
    comment: c.comment,
    submittedAt: c.submitted_at.toISOString(),
    decidedAt: c.decided_at?.toISOString() ?? null,
  };
}

/** Снимок карточки для модератора (поля, график, фото, шаблон). */
function placeSnapshot(p: PartnerPlaceDto): JsonObject {
  return {
    template: p.template.code,
    status: p.status,
    categoryId: p.categoryId,
    localityId: p.localityId,
    name: p.name,
    description: p.description,
    address: p.address,
    location: p.location,
    phone: p.phone,
    website: p.website,
    telegram: p.telegram,
    tagIds: p.tagIds,
    schedule: { weekly: p.schedule.weekly, exceptions: p.schedule.exceptions } as unknown as JsonObject,
    media: p.media.map((m) => ({ mediaAssetId: m.mediaAssetId, isCover: m.isCover, alt: m.alt })),
  };
}

function toOfferDto(o: Offer): OfferDto {
  return {
    id: o.id,
    placeId: o.place_id,
    title: o.title_i18n,
    description: o.description_i18n,
    startsAt: o.starts_at?.toISOString() ?? null,
    endsAt: o.ends_at?.toISOString() ?? null,
    status: o.status,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
  };
}

function offerSnapshot(o: Offer): JsonObject {
  return {
    placeId: o.place_id,
    title: o.title_i18n,
    description: o.description_i18n,
    startsAt: o.starts_at?.toISOString() ?? null,
    endsAt: o.ends_at?.toISOString() ?? null,
    status: o.status,
  };
}

function toMember(m: StaffMemberRow, me: string): PartnerStaffMemberDto {
  return {
    assignmentId: m.assignment_id,
    userId: m.user_id,
    displayName: m.display_name,
    username: m.username,
    role: m.role as PartnerRole,
    grantedAt: m.granted_at.toISOString(),
    isMe: m.user_id === me,
  };
}

function toInviteDto(i: StaffInvite, now: Date, acceptedByName: string | null): StaffInviteDto {
  return {
    id: i.id,
    role: i.role,
    state: inviteState(i, now),
    expiresAt: i.expires_at.toISOString(),
    createdAt: i.created_at.toISOString(),
    acceptedAt: i.accepted_at?.toISOString() ?? null,
    acceptedByName,
  };
}

function checkPeriod(startsAt: string | null, endsAt: string | null): void {
  if (!validOfferPeriod(startsAt, endsAt))
    throw new ApiError("UNPROCESSABLE", {
      messageKey: "errors.partner.offerPeriod",
      details: { reason: "offer_period_invalid" },
    });
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

export function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown };
  return err.code === "23505" && err.constraint === constraint;
}

const MEDIA_ERROR_CODE = {
  mime_not_allowed: "UNPROCESSABLE",
  size_invalid: "UNPROCESSABLE",
  size_too_large: "UNPROCESSABLE",
  owner_region_mismatch: "UNPROCESSABLE",
  not_uploaded: "CONFLICT",
} as const;

function rethrowMediaError(e: unknown): never {
  if (!(e instanceof MediaError)) throw e;
  throw new ApiError(MEDIA_ERROR_CODE[e.reason], { details: { reason: e.reason }, cause: e });
}

function rethrowRoleError(e: unknown): never {
  if (!(e instanceof RoleAssignmentError)) throw e;
  if (e.reason === "already_assigned")
    throw new ApiError("CONFLICT", {
      messageKey: "errors.staffInvite.alreadyMember",
      details: { reason: e.reason },
    });
  if (e.reason === "not_found") throw new ApiError("NOT_FOUND", { details: { reason: e.reason } });
  if (e.reason === "role_not_assignable") throw new ApiError("FORBIDDEN", { details: { reason: e.reason } });
  throw new ApiError("UNPROCESSABLE", { details: { reason: e.reason }, cause: e });
}
