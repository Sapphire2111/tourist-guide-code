import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength, ValidateBy } from "class-validator";
import { CursorQueryDto } from "../../common/http/index.js";
import { AUDIT_ACTOR_TYPES, type AuditActorType, type AuditLog } from "../../db/index.js";

// DTO админского API аудита. ПДн-часть (IP, user agent, session id) в ответ не входит.

/** RFC 3339 date-time со смещением: 2026-11-01T10:00:00Z, 2026-11-01T10:00:00.123+02:00. */
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Дата-время RFC 3339 с обязательным смещением. IsISO8601 пропускает недели и порядковые дни (2026-W01, 2026-123),
 * которые Date не разбирает (Invalid Date → 500), а время без смещения читается в зоне сервера.
 */
function IsRfc3339DateTime(): PropertyDecorator {
  return ValidateBy({
    name: "isRfc3339DateTime",
    validator: {
      validate: (v: unknown) =>
        typeof v === "string" && RFC3339_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)),
    },
  });
}

export class AuditLogsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 100, example: "qr_point.create" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ type: String, maxLength: 100, example: "region" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ type: String, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ type: String, format: "date-time", description: "Начало периода (включительно)" })
  @IsOptional()
  @IsRfc3339DateTime()
  from?: string;

  @ApiPropertyOptional({ type: String, format: "date-time", description: "Конец периода (не включительно)" })
  @IsOptional()
  @IsRfc3339DateTime()
  to?: string;
}

export class AuditLogDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: AUDIT_ACTOR_TYPES, enumName: "AuditActorType" }) actorType!: AuditActorType;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) actorUserId!: string | null;
  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description: "null — действие уровня платформы",
  })
  regionId!: string | null;
  @ApiProperty({ type: String, example: "role.assign" }) action!: string;
  @ApiProperty({ type: String }) entityType!: string;
  @ApiProperty({ type: String, nullable: true }) entityId!: string | null;
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  oldValues!: Record<string, unknown> | null;
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  newValues!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Correlation id запроса" })
  requestId!: string | null;
  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Назначение роли, по которому действовал пользователь",
  })
  roleAssignmentId!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

/** Запись журнала → ответ API (без ПДн-части: она в другой таблице и сюда не читается). */
export function toAuditLogDto(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    regionId: row.region_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    reason: row.reason,
    requestId: row.request_id,
    roleAssignmentId: row.role_assignment_id,
    createdAt: row.created_at.toISOString(),
  };
}
