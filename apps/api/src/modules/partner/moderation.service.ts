import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  currentDb,
  InjectDb,
  PLATFORM_CONTEXT,
  regionContext,
  withTenant,
  type Db,
  type ModerationCaseStatus,
  type ModerationDecision,
  type VerificationMethod,
} from "../../db/index.js";
import { AuditService } from "../audit/index.js";
import { CatalogRepository, CatalogService, rethrowCatalogError } from "../catalog/index.js";
import { NotificationsService } from "../host/index.js";
import { MediaService } from "../media/index.js";
import { isGrantActive, RbacService, regionScope, roleHasPermission, type Grant } from "../rbac/index.js";
import { DECISION_PLACE_STATUS } from "./partner-rules.js";
import type {
  ModerationCaseDetailDto,
  ModerationCaseDto,
  ModerationCaseListDto,
  ModerationOwnerDto,
} from "./partner.dto.js";
import { PartnerRepository, type ModerationCaseRow } from "./partner.repository.js";
import { MODERATION_CASE_ENTITY, type AuditMeta } from "./partner.service.js";

export type ModerationDecisionInput = {
  decision: ModerationDecision;
  comment?: string;
  verificationMethod?: VerificationMethod;
};

export const MODERATION_AUDIT: Readonly<Record<ModerationDecision, string>> = {
  approve: "moderation.approve",
  reject: "moderation.reject",
  changes_requested: "moderation.return",
};
export const NOTIFICATION_TEMPLATE_DECISION = "moderation.decision";

const QUEUE_LIMIT = 200;
/** Возможные дубли места: радиус и сколько показать (AD02). */
export const DUPLICATE_RADIUS_METERS = 150;
const DUPLICATE_LIMIT = 5;

/** Где пользователь модерирует: вся платформа (SUPERADMIN) или набор регионов (MODERATOR, REGION_ADMIN — C-15). */
type ModerationScope = { platform: boolean; regions: Set<string>; grants: Grant[] };

const DECISION_TEXT: Readonly<Record<ModerationDecision, string>> = {
  approve: "схвалено — заклад опубліковано",
  reject: "відхилено",
  changes_requested: "повернуто на доопрацювання",
};

/**
 * Модерация мест партнёров (AD02, S-05 п. 5; states-and-rules §1.1, §1.3). Право place.moderate — по назначениям
 * пользователя на регион заявки (MODERATOR и REGION_ADMIN — свой регион, SUPERADMIN — все); заявка чужого региона —
 * 403. Решение: заявка → decided, место → published / rejected / changes_requested, AuditLog с причиной, владельцам
 * организации — уведомление ботом после коммита.
 */
@Injectable()
export class ModerationService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PartnerRepository) private readonly repo: PartnerRepository,
    @Inject(CatalogRepository) private readonly catalogRepo: CatalogRepository,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  now: () => Date = () => new Date();

  async list(
    userId: string,
    filter: { status: ModerationCaseStatus; regionId?: string; placeId?: string },
  ): Promise<ModerationCaseListDto> {
    const s = await this.scopeOf(userId);
    const regionId = filter.regionId?.toLowerCase();
    if (regionId && !s.platform && !s.regions.has(regionId)) throw forbidden("region_forbidden");
    const query = () =>
      this.repo.listCases({
        status: filter.status,
        placeId: filter.placeId?.toLowerCase(),
        limit: QUEUE_LIMIT,
      });
    let rows: ModerationCaseRow[];
    if (regionId) rows = await withTenant(this.db, regionContext(regionId), query);
    else if (s.platform) rows = await withTenant(this.db, PLATFORM_CONTEXT, query);
    else {
      rows = [];
      for (const r of s.regions) rows.push(...(await withTenant(this.db, regionContext(r), query)));
      rows.sort((a, b) =>
        filter.status === "open"
          ? a.submitted_at.getTime() - b.submitted_at.getTime()
          : b.submitted_at.getTime() - a.submitted_at.getTime(),
      );
    }
    const now = this.now();
    return {
      items: rows
        .slice(0, QUEUE_LIMIT)
        .map((r) => toCaseDto(r, relatedTo(s.grants, r.organization_id, r.place_id, now))),
    };
  }

  async get(userId: string, id: string): Promise<ModerationCaseDetailDto> {
    const { regionId, grants } = await this.caseAccess(userId, id);
    return withTenant(this.db, regionContext(regionId), async () => {
      const row = await this.repo.caseRow(id.toLowerCase());
      if (!row) throw notFound();
      const place = await this.catalogRepo.findPlace(row.place_id);
      const [owners, history, problems, duplicates, preview] = await Promise.all([
        this.repo.staffOf(row.organization_id),
        this.repo.placeHistory(row.place_id, row.id),
        this.catalog.publishCheck(row.place_id).catch(rethrowCatalogError),
        this.repo.possibleDuplicates(
          row.place_id,
          place?.name_i18n.uk ?? row.place_name.uk,
          place?.location ?? null,
          DUPLICATE_RADIUS_METERS,
          DUPLICATE_LIMIT,
        ),
        this.snapshotPreview(row.place_snapshot),
      ]);
      const own = relatedTo(grants, row.organization_id, row.place_id, this.now());
      return {
        ...toCaseDto(row, own),
        placeSnapshot: row.place_snapshot,
        possibleDuplicates: duplicates.map((d) => ({
          id: d.id,
          name: d.name_i18n,
          status: d.status as ModerationCaseDto["placeStatus"],
          source: d.source === "google" ? "google" : "manual",
          distanceMeters: d.distance === null ? null : Math.round(Number(d.distance)),
        })),
        snapshotMediaPreview: preview,
        partnerNote: row.partner_note,
        owners: owners
          .filter((m) => m.role === "ORG_OWNER")
          .map(
            (m): ModerationOwnerDto => ({
              userId: m.user_id,
              displayName: m.display_name,
              username: m.username,
            }),
          ),
        history: history.map((h) => toCaseDto(h, own)),
        publishProblems: [...problems],
      };
    });
  }

  async decide(
    userId: string,
    id: string,
    input: ModerationDecisionInput,
    meta: AuditMeta,
  ): Promise<ModerationCaseDto> {
    const { regionId, grant, grants } = await this.caseAccess(userId, id);
    const comment = input.comment?.trim() || null;
    if (input.decision !== "approve" && !comment)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "reason", constraint: "isDefined", messageKey: "errors.validation.isDefined" }],
        },
      });
    const { dto, notify } = await withTenant(this.db, regionContext(regionId), async () => {
      const kase = await this.repo.findCase(id.toLowerCase(), true);
      if (!kase) throw notFound();
      // BR-12: модератор не решает заявку организации, в которой у него есть роль.
      if (relatedTo(grants, kase.organization_id, kase.place_id, this.now()))
        throw forbidden("own_organization");
      if (kase.status !== "open")
        throw new ApiError("CONFLICT", {
          messageKey: "errors.moderation.alreadyDecided",
          details: { reason: "already_decided", decision: kase.decision, decidedBy: kase.decided_by },
        });
      const place = await this.catalogRepo.lockPlace(kase.place_id);
      if (!place) throw notFound();
      if (place.status !== "pending_moderation")
        throw new ApiError("CONFLICT", {
          messageKey: "errors.moderation.notPending",
          details: { reason: "place_not_pending", status: place.status },
        });
      if (input.decision === "approve") {
        await this.catalogRepo.shareLockCategory(place.category_id);
        const problems = await this.catalog.publishCheck(place.id).catch(rethrowCatalogError);
        if (problems.length > 0)
          throw new ApiError("UNPROCESSABLE", {
            messageKey: "errors.place.notPublishable",
            details: { reason: "not_publishable", problems: [...problems] },
          });
      }
      const decided = await this.repo.decideCase(kase.id, {
        decision: input.decision,
        comment,
        verification_method: input.decision === "approve" ? (input.verificationMethod ?? null) : null,
        decided_by: userId,
      });
      if (!decided)
        throw new ApiError("CONFLICT", {
          messageKey: "errors.moderation.alreadyDecided",
          details: { reason: "already_decided" },
        });
      const status = DECISION_PLACE_STATUS[input.decision];
      await this.catalogRepo.updatePlace(place.id, {
        status,
        first_published_at:
          input.decision === "approve" && place.first_published_at === null ? this.now() : undefined,
      });
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: MODERATION_AUDIT[input.decision],
        entityType: MODERATION_CASE_ENTITY,
        entityId: kase.id,
        reason: comment ?? `verification:${input.verificationMethod ?? "none"}`,
        oldValues: { caseStatus: "open", placeId: place.id, placeStatus: place.status },
        newValues: {
          caseStatus: "decided",
          decision: input.decision,
          placeStatus: status,
          verificationMethod: decided.verification_method,
        },
        regionId,
      });
      const owners = (await this.repo.staffOf(kase.organization_id)).filter((m) => m.role === "ORG_OWNER");
      const notify = await this.notifications.enqueue(
        owners.map((o) => ({
          recipientUserId: o.user_id,
          template: NOTIFICATION_TEMPLATE_DECISION,
          entityType: MODERATION_CASE_ENTITY,
          entityId: kase.id,
          body:
            `Модерація «${place.name_i18n.uk}»: ${DECISION_TEXT[input.decision]}.` +
            (comment ? ` Коментар модератора: ${comment}` : ""),
        })),
      );
      const row = await this.repo.caseRow(kase.id);
      if (!row) throw notFound();
      return { dto: toCaseDto(row), notify };
    });
    this.notifications.dispatchInBackground(regionId, notify);
    return dto;
  }

  // --- внутреннее ---

  /** Ссылки превью фото снимка строятся при чтении (в снимке — только id фото: подписанные ссылки истекают). */
  private async snapshotPreview(snapshot: Record<string, unknown>): Promise<Record<string, string>> {
    const media = Array.isArray(snapshot.media) ? (snapshot.media as { mediaAssetId?: unknown }[]) : [];
    const out: Record<string, string> = {};
    for (const m of media) {
      if (typeof m.mediaAssetId !== "string") continue;
      const asset = await this.media.find(m.mediaAssetId);
      if (asset?.status !== "ready") continue;
      const links = await this.media.links(asset);
      const link = links.find((l) => l.name === "w320") ?? links[0];
      if (link) out[m.mediaAssetId] = link.url;
    }
    return out;
  }

  private async scopeOf(userId: string): Promise<ModerationScope> {
    const grants = await this.rbac.grantsOf(userId);
    const now = this.now();
    const s: ModerationScope = { platform: false, regions: new Set(), grants };
    for (const g of grants) {
      if (!isGrantActive(g, now) || !roleHasPermission(g.role, "place.moderate")) continue;
      if (g.scopeType === "PLATFORM") s.platform = true;
      else if (g.scopeType === "REGION" && g.scopeId) s.regions.add(g.scopeId.toLowerCase());
    }
    if (!s.platform && s.regions.size === 0) throw forbidden("not_moderator");
    return s;
  }

  /** Регион заявки (из БД) и назначение с правом place.moderate на него; нет заявки — 404, чужой регион — 403. */
  private async caseAccess(
    userId: string,
    id: string,
  ): Promise<{ regionId: string; grant: Grant; grants: Grant[] }> {
    const grants = await this.rbac.grantsOf(userId);
    const regionId = await this.repo.caseRegion(id.toLowerCase());
    if (!regionId) throw notFound();
    const auth = await this.rbac.authorize(grants, "place.moderate", regionScope(regionId), this.now());
    if (!auth) throw forbidden("region_forbidden");
    return { regionId, grant: auth.grant, grants };
  }
}

/** Есть ли у модератора действующая роль в организации заявки или на её месте (BR-12). */
function relatedTo(grants: readonly Grant[], organizationId: string, placeId: string, now: Date): boolean {
  const ids = new Set([organizationId.toLowerCase(), placeId.toLowerCase()]);
  return grants.some(
    (g) =>
      isGrantActive(g, now) &&
      (g.scopeType === "ORGANIZATION" || g.scopeType === "PLACE") &&
      !!g.scopeId &&
      ids.has(g.scopeId.toLowerCase()),
  );
}

const notFound = () => new ApiError("NOT_FOUND");
const forbidden = (reason: string) => new ApiError("FORBIDDEN", { details: { reason } });

export function toCaseDto(r: ModerationCaseRow, ownOrganization = false): ModerationCaseDto {
  return {
    id: r.id,
    regionId: r.region_id,
    placeId: r.place_id,
    placeName: r.place_name,
    placeStatus: r.place_status as ModerationCaseDto["placeStatus"],
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    templateCode: r.template_code,
    templateName: r.template_name,
    status: r.status,
    decision: r.decision,
    comment: r.comment,
    verificationMethod: r.verification_method,
    submittedBy: r.submitted_by,
    submittedByName: r.submitted_by_name,
    submittedAt: r.submitted_at.toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decidedByName: r.decided_by_name,
    ownOrganization,
  };
}
