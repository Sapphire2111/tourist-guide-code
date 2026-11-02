// Публичный интерфейс контекста role-assignments: назначение и отзыв ролей (T1-12).
export { RoleAssignmentsModule } from "./role-assignments.module.js";
export {
  ROLE_ASSIGNMENT_ENTITY,
  ROLE_AUDIT_ACTIONS,
  RoleAssignmentError,
  RoleAssignmentService,
  canAssignRole,
  type AssignRoleInput,
  type RevokeRoleInput,
  type RoleAssignmentErrorReason,
} from "./role-assignment.service.js";
