import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { CursorPage } from "@tg/shared";
import { ApiCursorPage, ApiErrors } from "../../common/http/index.js";
import { RequirePermission, scopeFromTenant } from "../rbac/index.js";
import { AuditLogRepository } from "./audit-log.repository.js";
import { decodeAuditCursor, encodeAuditCursor } from "./audit-cursor.js";
import { AuditLogDto, toAuditLogDto } from "./audit.dto.js";
// AuditLogsQueryDto нужен в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AuditLogsQueryDto } from "./audit.dto.js";

const DEFAULT_LIMIT = 20;

/**
 * Чтение аудита для админа (каркас T1-13). Регион — из tenant-контекста запроса (TenantContextInterceptor):
 * регион-админ видит свой регион, PLATFORM — все. Доступ — право audit.read на область tenant-контекста (T1-12):
 * назначение на регион — лента региона, на PLATFORM — вся платформа.
 */
@ApiTags("admin")
@Controller("admin/audit-logs")
@RequirePermission("audit.read", scopeFromTenant)
export class AuditController {
  constructor(@Inject(AuditLogRepository) private readonly audit: AuditLogRepository) {}

  @Get()
  @ApiOperation({ operationId: "listAuditLogs", summary: "Журнал действий, от новых к старым" })
  @ApiCursorPage(AuditLogDto)
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  async list(@Query() q: AuditLogsQueryDto): Promise<CursorPage<AuditLogDto>> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const beforeId = q.cursor === undefined ? undefined : decodeAuditCursor(q.cursor);
    // Лишняя запись — признак следующей страницы.
    const rows = await this.audit.search(
      {
        action: q.action,
        entityType: q.entityType,
        entityId: q.entityId,
        actorUserId: q.actorUserId,
        from: q.from === undefined ? undefined : new Date(q.from),
        to: q.to === undefined ? undefined : new Date(q.to),
      },
      { limit: limit + 1, beforeId },
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditLogDto),
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last.id) : null,
    };
  }
}
