import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  currentDb,
  InjectDb,
  PLATFORM_CONTEXT,
  regionContext,
  withTenant,
  type Db,
  type PlaceClaim,
  type PlaceClaimStatus,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { CatalogRepository } from "../catalog/index.js";
import { NotificationsService, type NotificationDraft } from "../host/index.js";
import {
  isGrantActive,
  RbacService,
  regionScope,
  roleHasPermission,
  scope,
  type Grant,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { RoleAssignmentService } from "../role-assignments/index.js";
import {
  AUTO_REJECT_COMMENT,
  CLAIM_DECISION_STATUS,
  claimBlocker,
  claimDecisionText,
  claimOrganization,
  DECIDED_CLAIM_STATUSES,
  isClaimDecidable,
  templateForCategory,
  type ClaimDecision,
} from "./claim-rules.js";
import type {
  ClaimQueueStatus,
  CreatePlaceClaimDto,
  PlaceClaimDetailDto,
  PlaceClaimDto,
  PlaceClaimListDto,
  PlaceClaimQueueDto,
  PlaceClaimSummaryDto,
} from "./place-claims.dto.js";
import { PlaceClaimsRepository, type PlaceClaimRow } from "./place-claims.repository.js";
import { PartnerRepository } from "./partner.repository.js";
import { isUniqueViolation, organizationName, PARTNER_AUDIT, type AuditMeta } from "./partner.service.js";

export const PLACE_CLAIM_ENTITY = "place_claim";
export const PLACE_CLAIM_AUDIT = {
  create: "place_claim.create",
  approve: "place_claim.approve",
  reject: "place_claim.reject",
  autoReject: "place_claim.auto_reject",
  /** На месте (entity place): привязка к организации; импорт защищает место по organization_id (places-import/writer.ts). */
  placeAssign: "place.claim_assign",
} as const;
export const NOTIFICATION_TEMPLATE_CLAIM_OPENED = "place_claim.opened";
export const NOTIFICATION_TEMPLATE_CLAIM_DECISION = "place_claim.decision";

const QUEUE_LIMIT = 200;

const notFound = () => new ApiError("NOT_FOUND");
const forbidden = (reason: string) => new ApiError("FORBIDDEN", { details: { reason } });
const alreadyDecided = (claim?: Pick<PlaceClaim, "status" | "decided_by">) =>
  new ApiError("CONFLICT", {
    messageKey: "errors.placeClaim.alreadyDecided",
    details: {
      reason: "already_decided",
      ...(claim ? { status: claim.status, decidedBy: claim.decided_by } : {}),
    },
  });
const alreadyClaimed = () =>
  new ApiError("CONFLICT", {
    messageKey: "errors.placeClaim.alreadyClaimed",
    details: { reason: "place_claimed" },
  });

type ClaimScope = { platform: boolean; regions: Set<string>; grants: Grant[] };

/**
 * «Це мій заклад» (0031): заявка на существующее место каталога (без организации) и ручная проверка модератором.
 * Заявитель — любой пользователь с сессией; организация — своя (ORG_OWNER) или новая при одобрении. Решение —
 * право place_claim.decide на регион заявки (MODERATOR, REGION_ADMIN, SUPERADMIN): одобрение привязывает место к
 * организации (место остаётся published, source не меняется), заявитель — ORG_OWNER новой организации, другие
 * заявки места на рассмотрении — отказ. Всё — в транзакции региона с AuditLog; уведомления ботом — после коммита.
 */
@Injectable()
export class PlaceClaimsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PlaceClaimsRepository) private readonly claims: PlaceClaimsRepository,
    @Inject(PartnerRepository) private readonly partners: PartnerRepository,
    @Inject(CatalogRepository) private readonly catalogRepo: CatalogRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(RoleAssignmentService) private readonly roles: RoleAssignmentService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  now: () => Date = () => new Date();

  // --- заявитель (Mini App) ---

  async create(userId: string, input: CreatePlaceClaimDto, meta: AuditMeta): Promise<PlaceClaimDto> {
    const region = await this.regions.findById(input.regionId.toLowerCase());
    if (region?.status !== "active") throw notFound();
    const regionId = region.id;
    const choice = claimOrganization(input, await this.ownerOrgIds(userId, regionId));
    if (choice === "organization_choice_required")
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          reason: choice,
          fields: [
            { field: "organizationId", constraint: "isDefined", messageKey: "errors.validation.isDefined" },
          ],
        },
      });
    if (choice === "not_org_owner") throw forbidden(choice);
    const { dto, notify } = await withTenant(this.db, regionContext(regionId), async () => {
      const place = await this.catalogRepo.lockPlace(input.placeId.toLowerCase());
      if (!place) throw notFound();
      const blocker = claimBlocker(place);
      // Неопубликованное место туристу не видно — как несуществующее.
      if (blocker === "place_not_published") throw notFound();
      if (blocker === "place_claimed") throw alreadyClaimed();
      let claim: PlaceClaim;
      try {
        claim = await this.claims.insert({
          place_id: place.id,
          user_id: userId,
          organization_id: choice.kind === "existing" ? choice.organizationId : null,
          new_organization_name: choice.kind === "new" ? organizationName(choice.name) : null,
          claimant_role: input.role,
          phone: input.phone,
          phone_source: input.phoneSource,
          comment: input.comment?.trim() || null,
        });
      } catch (e) {
        if (isUniqueViolation(e, "place_claims_pending_key"))
          throw new ApiError("CONFLICT", {
            messageKey: "errors.placeClaim.duplicate",
            details: { reason: "claim_pending" },
          });
        throw e;
      }
      await this.record(meta, {
        action: PLACE_CLAIM_AUDIT.create,
        entityType: PLACE_CLAIM_ENTITY,
        entityId: claim.id,
        newValues: {
          placeId: place.id,
          role: claim.claimant_role,
          organizationId: claim.organization_id,
          newOrganizationName: claim.new_organization_name,
          phoneSource: claim.phone_source,
        },
        regionId,
      });
      const moderators = await this.partners.regionModerators(regionId);
      const notify = await this.notifications.enqueue(
        moderators
          .filter((id) => id !== userId)
          .map((id) => ({
            recipientUserId: id,
            template: NOTIFICATION_TEMPLATE_CLAIM_OPENED,
            entityType: PLACE_CLAIM_ENTITY,
            entityId: claim.id,
            body: `Нова заявка «Це мій заклад»: «${place.name_i18n.uk}». Перевірте в адмінці (Модерація → Заявки на заклад).`,
          })),
      );
      const row = await this.claims.row(claim.id);
      if (!row) throw notFound();
      return { dto: toClaimDto(row), notify };
    });
    this.notifications.dispatchInBackground(regionId, notify);
    return dto;
  }

  async mine(userId: string, regionId: string): Promise<PlaceClaimListDto> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw notFound();
    const rows = await withTenant(this.db, regionContext(region.id), () => this.claims.mine(userId));
    return { items: rows.map(toClaimDto) };
  }

  // --- модератор (админка) ---

  async queue(
    userId: string,
    filter: { status: ClaimQueueStatus; regionId?: string },
  ): Promise<PlaceClaimQueueDto> {
    const s = await this.scopeOf(userId);
    const regionId = filter.regionId?.toLowerCase();
    if (regionId && !s.platform && !s.regions.has(regionId)) throw forbidden("region_forbidden");
    const statuses: readonly PlaceClaimStatus[] =
      filter.status === "pending" ? ["pending"] : DECIDED_CLAIM_STATUSES;
    const query = () => this.claims.queue({ statuses, limit: QUEUE_LIMIT });
    let rows: PlaceClaimRow[];
    if (regionId) rows = await withTenant(this.db, regionContext(regionId), query);
    else if (s.platform) rows = await withTenant(this.db, PLATFORM_CONTEXT, query);
    else {
      rows = [];
      for (const r of s.regions) rows.push(...(await withTenant(this.db, regionContext(r), query)));
      const dir = filter.status === "pending" ? 1 : -1;
      rows.sort((a, b) => dir * (a.created_at.getTime() - b.created_at.getTime()));
    }
    const now = this.now();
    return {
      items: rows.slice(0, QUEUE_LIMIT).map((r) => toSummaryDto(r, isOwn(s.grants, userId, r, now))),
    };
  }

  async get(userId: string, id: string): Promise<PlaceClaimDetailDto> {
    const { regionId, grants } = await this.claimAccess(userId, id);
    return withTenant(this.db, regionContext(regionId), async () => {
      const row = await this.claims.row(id.toLowerCase());
      if (!row) throw notFound();
      const [place, others] = await Promise.all([
        this.claims.claimPlace(row.place_id),
        this.claims.ofPlace(row.place_id, row.id),
      ]);
      if (!place) throw notFound();
      const now = this.now();
      return {
        ...toSummaryDto(row, isOwn(grants, userId, row, now)),
        phone: row.phone,
        phoneSource: row.phone_source,
        comment: row.comment,
        place: {
          id: place.id,
          name: place.name_i18n,
          status: place.status as PlaceClaimDetailDto["place"]["status"],
          source: place.source === "google" ? "google" : "manual",
          address: place.address_i18n?.uk ?? null,
          phone: place.phone,
          website: place.website,
          googleMapsUri:
            place.maps_uri ??
            (place.google_place_id
              ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.google_place_id)}`
              : null),
          category: place.category_name?.uk ?? null,
          organizationName: place.organization_name,
        },
        otherClaims: others.map((o) => toSummaryDto(o, isOwn(grants, userId, o, now))),
      };
    });
  }

  async decide(
    userId: string,
    id: string,
    decision: ClaimDecision,
    rawComment: string | undefined,
    meta: AuditMeta,
  ): Promise<PlaceClaimSummaryDto> {
    const { regionId, grant, grants } = await this.claimAccess(userId, id);
    const comment = rawComment?.trim() || null;
    if (decision === "reject" && !comment)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "reason", constraint: "isDefined", messageKey: "errors.validation.isDefined" }],
        },
      });
    const audited: AuditMeta = { ...meta, roleAssignmentId: grant.id };
    const { dto, notify } = await withTenant(this.db, regionContext(regionId), async (trx) => {
      const claim = await this.claims.find(id.toLowerCase(), true);
      if (!claim) throw notFound();
      if (isOwn(grants, userId, claim, this.now()))
        throw forbidden(claim.user_id === userId ? "own_claim" : "own_organization");
      if (!isClaimDecidable(claim.status)) throw alreadyDecided(claim);
      const place = await this.catalogRepo.lockPlace(claim.place_id);
      if (!place) throw notFound();
      const drafts: NotificationDraft[] = [];
      let organizationId: string | undefined;
      if (decision === "approve") {
        if (place.organization_id !== null) throw alreadyClaimed();
        if (place.status !== "published")
          throw new ApiError("CONFLICT", {
            messageKey: "errors.placeClaim.placeNotPublished",
            details: { reason: "place_not_published", status: place.status },
          });
        organizationId = await this.claimantOrganization(trx, claim, audited, regionId);
        const category = await this.catalogRepo.findCategory(place.category_id);
        const template = place.partner_template_id
          ? null
          : templateForCategory(await this.partners.listTemplates(), category?.code);
        const assigned = await this.claims.assignPlace(place.id, organizationId, template?.id ?? null);
        if (!assigned) throw alreadyClaimed();
        await this.record(audited, {
          action: PLACE_CLAIM_AUDIT.placeAssign,
          entityType: "place",
          entityId: place.id,
          oldValues: { organizationId: null, partnerTemplateId: place.partner_template_id },
          newValues: {
            organizationId,
            partnerTemplateId: template?.id ?? place.partner_template_id,
            claimId: claim.id,
          },
          regionId,
        });
      }
      const decided = await this.claims.decide(claim.id, {
        status: CLAIM_DECISION_STATUS[decision],
        ...(organizationId ? { organization_id: organizationId } : {}),
        decision_comment: comment,
        decided_by: userId,
      });
      if (!decided) throw alreadyDecided();
      await this.record(audited, {
        action: decision === "approve" ? PLACE_CLAIM_AUDIT.approve : PLACE_CLAIM_AUDIT.reject,
        entityType: PLACE_CLAIM_ENTITY,
        entityId: claim.id,
        reason: comment,
        oldValues: { status: "pending", placeId: place.id },
        newValues: { status: decided.status, organizationId: decided.organization_id },
        regionId,
      });
      drafts.push({
        recipientUserId: claim.user_id,
        template: NOTIFICATION_TEMPLATE_CLAIM_DECISION,
        entityType: PLACE_CLAIM_ENTITY,
        entityId: claim.id,
        body: claimDecisionText(decision, place.name_i18n.uk, comment),
      });
      if (decision === "approve") {
        const competing = await this.claims.rejectCompeting(place.id, claim.id, {
          decision_comment: AUTO_REJECT_COMMENT,
          decided_by: userId,
        });
        for (const c of competing) {
          await this.record(audited, {
            action: PLACE_CLAIM_AUDIT.autoReject,
            entityType: PLACE_CLAIM_ENTITY,
            entityId: c.id,
            reason: AUTO_REJECT_COMMENT,
            oldValues: { status: "pending", placeId: place.id },
            newValues: { status: "rejected", approvedClaimId: claim.id },
            regionId,
          });
          drafts.push({
            recipientUserId: c.user_id,
            template: NOTIFICATION_TEMPLATE_CLAIM_DECISION,
            entityType: PLACE_CLAIM_ENTITY,
            entityId: c.id,
            body: claimDecisionText("reject", place.name_i18n.uk, AUTO_REJECT_COMMENT),
          });
        }
      }
      const notify = await this.notifications.enqueue(drafts);
      const row = await this.claims.row(claim.id);
      if (!row) throw notFound();
      return { dto: toSummaryDto(row, false), notify };
    });
    this.notifications.dispatchInBackground(regionId, notify);
    return dto;
  }

  // --- внутреннее ---

  /**
   * Организация одобряемой заявки: существующая — заявитель должен оставаться её ORG_OWNER (иначе 409); новая —
   * создаётся, заявитель получает ORG_OWNER (назначает SYSTEM, как онбординг: своего назначения у него ещё нет).
   */
  private async claimantOrganization(
    trx: Db,
    claim: PlaceClaim,
    meta: AuditMeta,
    regionId: string,
  ): Promise<string> {
    if (claim.organization_id) {
      const [org, staff] = await Promise.all([
        this.partners.findOrganization(claim.organization_id),
        this.partners.staffOf(claim.organization_id),
      ]);
      const owner = staff.some((m) => m.user_id === claim.user_id && m.role === "ORG_OWNER");
      if (org?.status !== "active" || !owner)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.placeClaim.claimantNotOwner",
          details: { reason: "claimant_not_owner" },
        });
      return org.id;
    }
    const org = await this.partners.createOrganization({
      name: organizationName(claim.new_organization_name ?? ""),
      created_by: claim.user_id,
    });
    const assignment = await this.roles.assign(trx, {
      userId: claim.user_id,
      role: "ORG_OWNER",
      scope: scope("ORGANIZATION", org.id),
      actor: { type: "system" },
      reason: "place_claim",
      requestId: meta.requestId ?? null,
    });
    await this.record(meta, {
      action: PARTNER_AUDIT.organizationCreate,
      entityType: "organization",
      entityId: org.id,
      newValues: {
        name: org.name,
        ownerAssignmentId: assignment.id,
        ownerUserId: claim.user_id,
        claimId: claim.id,
      },
      regionId,
    });
    return org.id;
  }

  /** Организации региона, где у пользователя действующая роль ORG_OWNER. */
  private async ownerOrgIds(userId: string, regionId: string): Promise<Set<string>> {
    const now = this.now();
    return new Set(
      (await this.rbac.grantsOf(userId))
        .filter(
          (g) =>
            g.role === "ORG_OWNER" &&
            g.scopeType === "ORGANIZATION" &&
            !!g.scopeId &&
            g.regionId?.toLowerCase() === regionId &&
            isGrantActive(g, now),
        )
        .map((g) => g.scopeId!.toLowerCase()),
    );
  }

  private async scopeOf(userId: string): Promise<ClaimScope> {
    const grants = await this.rbac.grantsOf(userId);
    const now = this.now();
    const s: ClaimScope = { platform: false, regions: new Set(), grants };
    for (const g of grants) {
      if (!isGrantActive(g, now) || !roleHasPermission(g.role, "place_claim.decide")) continue;
      if (g.scopeType === "PLATFORM") s.platform = true;
      else if (g.scopeType === "REGION" && g.scopeId) s.regions.add(g.scopeId.toLowerCase());
    }
    if (!s.platform && s.regions.size === 0) throw forbidden("not_moderator");
    return s;
  }

  /** Регион заявки (из БД) и назначение с правом place_claim.decide на него; нет заявки — 404, чужой регион — 403. */
  private async claimAccess(
    userId: string,
    id: string,
  ): Promise<{ regionId: string; grant: Grant; grants: Grant[] }> {
    const grants = await this.rbac.grantsOf(userId);
    const regionId = await this.claims.claimRegion(id.toLowerCase());
    if (!regionId) throw notFound();
    const auth = await this.rbac.authorize(grants, "place_claim.decide", regionScope(regionId), this.now());
    if (!auth) throw forbidden("region_forbidden");
    return { regionId, grant: auth.grant, grants };
  }

  private async record(
    meta: AuditMeta,
    entry: Omit<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), { ...meta, ...entry });
  }
}

/**
 * Модератор не решает свою заявку и заявку в организацию, где у него есть роль (BR-12, как модерация мест).
 */
function isOwn(
  grants: readonly Grant[],
  userId: string,
  claim: Pick<PlaceClaim, "user_id" | "organization_id">,
  now: Date,
): boolean {
  if (claim.user_id === userId) return true;
  const org = claim.organization_id?.toLowerCase();
  if (!org) return false;
  return grants.some(
    (g) => isGrantActive(g, now) && g.scopeType === "ORGANIZATION" && g.scopeId?.toLowerCase() === org,
  );
}

export function toClaimDto(r: PlaceClaimRow): PlaceClaimDto {
  return {
    id: r.id,
    regionId: r.region_id,
    placeId: r.place_id,
    placeName: r.place_name,
    role: r.claimant_role,
    status: r.status,
    organizationId: r.organization_id,
    organizationName: r.organization_name ?? "",
    decisionComment: r.decision_comment,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  };
}

function toSummaryDto(r: PlaceClaimRow, own: boolean): PlaceClaimSummaryDto {
  return {
    ...toClaimDto(r),
    userId: r.user_id,
    claimantName: r.claimant_name,
    claimantUsername: r.claimant_username,
    newOrganization: r.new_organization_name !== null,
    decidedByName: r.decided_by_name,
    own,
  };
}
