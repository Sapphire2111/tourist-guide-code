import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RoleAssignmentService } from "./role-assignment.service.js";

/**
 * Назначение и отзыв ролей с записью в аудит (T1-12). Отдельный контекст: rbac не зависит от audit (audit
 * сам использует rbac для @RequirePermission), а сервис назначений нужен обоим.
 */
@Module({
  imports: [RbacModule, AuditModule],
  providers: [RoleAssignmentService],
  exports: [RoleAssignmentService],
})
export class RoleAssignmentsModule {}
