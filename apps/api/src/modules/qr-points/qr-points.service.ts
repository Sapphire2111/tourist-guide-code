import { Inject, Injectable } from "@nestjs/common";
import { renderSVG } from "uqr";
import {
  currentDb,
  InjectDb,
  type Db,
  type JsonObject,
  type LocalizedText,
  type QrPoint,
  type QrPointType,
  type QrPointUpdate,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { generateQrCode } from "../qr-context/index.js";
import { QrPointsRepository, type QrPointFilter } from "./qr-points.repository.js";

/** Настройки печати QR (QrPointsModule.forRoot): имя бота — TELEGRAM_BOT_USERNAME. */
export type QrPrintOptions = { readonly botUsername?: string };
export const QR_PRINT_OPTIONS = Symbol("QR_PRINT_OPTIONS");

export const QR_POINT_ENTITY = "qr_point";
export const QR_POINT_AUDIT = {
  create: "qr_point.create",
  update: "qr_point.update",
  activate: "qr_point.activate",
  deactivate: "qr_point.deactivate",
} as const;

/** Попыток подобрать свободный код: 12 символов base62 — коллизия практически невозможна, но не исключена. */
const CODE_ATTEMPTS = 5;

export type QrVenueInput = {
  name: LocalizedText;
  description?: LocalizedText | null;
  address?: LocalizedText | null;
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
};

export type CreateQrPointInput = {
  regionId: string;
  type: QrPointType;
  label: string;
  campaign?: string | null;
  source?: string | null;
  placeId?: string | null;
  venue?: QrVenueInput | null;
  roomLabel?: string | null;
};

export type UpdateQrPointInput = {
  label?: string;
  campaign?: string | null;
  source?: string | null;
  placeId?: string | null;
  venue?: QrVenueInput | null;
  roomLabel?: string | null;
};

/** Кто действует — для аудита (auditFromRequest). */
export type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

export type QrPointErrorReason =
  | "venue_hotel_only"
  | "room_hotel_only"
  | "campaign_required"
  | "code_generation_failed"
  | "bot_username_not_configured"
  | "qr_point_inactive";

export class QrPointError extends Error {
  override readonly name = "QrPointError";
  constructor(readonly reason: QrPointErrorReason) {
    super(`QrPoint: ${reason}`);
  }
}

export type QrPrint = { point: QrPoint; deepLink: string; svg: string };

/**
 * QR-менеджмент админки (AD04, блок 3; ADR-0016, ADR-0018). Все методы — в транзакции запроса (currentDb):
 * изменение и запись аудита коммитятся вместе. Код генерирует сервер (generateQrCode из qr-context), туристу и
 * админу он не задаётся; тип и код не меняются — перевыпуск = новая точка + деактивация старой.
 */
@Injectable()
export class QrPointsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(QrPointsRepository) private readonly repo: QrPointsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QR_PRINT_OPTIONS) private readonly print: QrPrintOptions,
  ) {}

  list(filter: QrPointFilter, page: { limit: number; beforeId?: string }): Promise<QrPoint[]> {
    return this.repo.list(filter, page);
  }

  find(id: string): Promise<QrPoint | undefined> {
    return this.repo.findById(id);
  }

  async create(input: CreateQrPointInput, meta: AuditMeta): Promise<QrPoint> {
    checkRules(input.type, input.campaign ?? null, Boolean(input.venue), Boolean(input.roomLabel));
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const row = await this.repo.insertIfCodeFree({
        region_id: input.regionId,
        code: generateQrCode(),
        type: input.type,
        label: input.label.trim(),
        campaign: input.campaign ?? null,
        source: input.source ?? null,
        place_id: input.placeId ?? null,
        ...venueColumns(input.venue ?? null),
        room_label: input.roomLabel?.trim() || null,
      });
      if (!row) continue;
      await this.record(meta, QR_POINT_AUDIT.create, row, null, snapshot(row));
      return row;
    }
    throw new QrPointError("code_generation_failed");
  }

  /** undefined — точки нет (или она в другом регионе). Пустая правка — точка как есть, без аудита. */
  async update(id: string, input: UpdateQrPointInput, meta: AuditMeta): Promise<QrPoint | undefined> {
    const before = await this.repo.findById(id);
    if (!before) return undefined;
    const patch: QrPointUpdate = {};
    if (input.label !== undefined) patch.label = input.label.trim();
    if (input.campaign !== undefined) patch.campaign = input.campaign;
    if (input.source !== undefined) patch.source = input.source;
    if (input.placeId !== undefined) patch.place_id = input.placeId;
    if (input.venue !== undefined) Object.assign(patch, venueColumns(input.venue));
    if (input.roomLabel !== undefined) patch.room_label = input.roomLabel?.trim() || null;
    if (Object.keys(patch).length === 0) return before;
    const campaign = patch.campaign !== undefined ? patch.campaign : before.campaign;
    const hasVenue = input.venue !== undefined ? input.venue !== null : before.venue_name_i18n !== null;
    const room = patch.room_label !== undefined ? patch.room_label : before.room_label;
    checkRules(before.type, campaign ?? null, hasVenue, room !== null);
    const after = await this.repo.update(id, patch);
    if (!after) return undefined;
    const changed = diff(snapshot(before), snapshot(after));
    if (changed) await this.record(meta, QR_POINT_AUDIT.update, after, changed.old, changed.new);
    return after;
  }

  /** Включить/выключить точку; без изменения состояния — без записи и аудита. */
  async setActive(id: string, active: boolean, meta: AuditMeta): Promise<QrPoint | undefined> {
    const before = await this.repo.findById(id);
    if (!before) return undefined;
    if (before.active === active) return before;
    const after = await this.repo.update(id, { active });
    if (!after) return undefined;
    await this.record(
      meta,
      active ? QR_POINT_AUDIT.activate : QR_POINT_AUDIT.deactivate,
      after,
      { active: before.active },
      { active },
    );
    return after;
  }

  /**
   * Данные для печати: ссылка `https://t.me/<bot>?startapp=<code>` (основное Mini App бота) и её QR в SVG.
   * Без TELEGRAM_BOT_USERNAME — bot_username_not_configured; деактивированную точку не печатаем.
   */
  async printData(id: string): Promise<QrPrint | undefined> {
    const point = await this.repo.findById(id);
    if (!point) return undefined;
    if (!point.active) throw new QrPointError("qr_point_inactive");
    const deepLink = buildDeepLink(this.print.botUsername, point.code);
    return { point, deepLink, svg: renderQrSvg(deepLink) };
  }

  private async record(
    meta: AuditMeta,
    action: string,
    row: QrPoint,
    oldValues: JsonObject | null,
    newValues: JsonObject | null,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action,
      entityType: QR_POINT_ENTITY,
      entityId: row.id,
      oldValues,
      newValues,
      // В контексте PLATFORM запись аудита — в регион точки (её видит админ региона).
      regionId: row.region_id,
    });
  }
}

/** Ссылка Mini App по имени бота; имя проверяется по правилам Telegram (5–32 символа, латиница, цифры, _). */
export function buildDeepLink(botUsername: string | undefined, code: string): string {
  const bot = botUsername?.trim().replace(/^@/, "");
  if (!bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot)) throw new QrPointError("bot_username_not_configured");
  return `https://t.me/${bot}?startapp=${encodeURIComponent(code)}`;
}

/** SVG QR-кода: коррекция M (наклейка может потереться), поле 4 модуля (требование стандарта для сканеров). */
export function renderQrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 4, pixelSize: 10 });
}

function checkRules(type: QrPointType, campaign: string | null, hasVenue: boolean, hasRoom = false): void {
  if (hasVenue && type !== "hotel") throw new QrPointError("venue_hotel_only");
  if (hasRoom && type !== "hotel") throw new QrPointError("room_hotel_only");
  if (type === "campaign" && !campaign) throw new QrPointError("campaign_required");
}

function venueColumns(venue: QrVenueInput | null) {
  return {
    venue_name_i18n: venue?.name ?? null,
    venue_description_i18n: venue?.description ?? null,
    venue_address_i18n: venue?.address ?? null,
    venue_phone: venue?.phone ?? null,
    venue_website: venue?.website ?? null,
    venue_telegram: venue?.telegram ?? null,
  };
}

/** Поля точки для аудита (без ПДн: деловые контакты заклада, не туриста). */
function snapshot(row: QrPoint): JsonObject {
  return {
    code: row.code,
    type: row.type,
    label: row.label,
    campaign: row.campaign,
    source: row.source,
    placeId: row.place_id,
    active: row.active,
    venueName: row.venue_name_i18n,
    venueDescription: row.venue_description_i18n,
    venueAddress: row.venue_address_i18n,
    venuePhone: row.venue_phone,
    venueWebsite: row.venue_website,
    venueTelegram: row.venue_telegram,
    roomLabel: row.room_label,
  };
}

function diff(before: JsonObject, after: JsonObject): { old: JsonObject; new: JsonObject } | undefined {
  const old: JsonObject = {};
  const next: JsonObject = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    old[key] = before[key];
    next[key] = after[key];
  }
  return Object.keys(next).length ? { old, new: next } : undefined;
}
