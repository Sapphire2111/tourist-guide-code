import { Module } from "@nestjs/common";
import { RbacModule } from "../rbac/index.js";
import { AuditLogRepository } from "./audit-log.repository.js";
import { AuditController } from "./audit.controller.js";
import { AUDIT_PII_RETENTION_DAYS, AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "./audit.service.js";

/**
 * Контекст audit (T1-13): запись аудита в транзакции изменения (AuditService), репозиторий и API чтения для
 * админа. Срок хранения ПДн — провайдер AUDIT_PII_RETENTION_DAYS (тесты — overrideProvider).
 */
@Module({
  // RbacModule: guard @RequirePermission контроллера.
  imports: [RbacModule],
  controllers: [AuditController],
  providers: [
    AuditLogRepository,
    AuditService,
    { provide: AUDIT_PII_RETENTION_DAYS, useValue: DEFAULT_AUDIT_PII_RETENTION_DAYS },
  ],
  exports: [AuditLogRepository, AuditService],
})
export class AuditModule {}
