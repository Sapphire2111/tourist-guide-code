// Публичный интерфейс контекста catalog (блок 3, ADR-0017).
export { CatalogModule } from "./catalog.module.js";
export {
  CatalogRepository,
  type LocalityRecord,
  type PlaceMediaRecord,
  type PlaceRecord,
} from "./catalog.repository.js";
export {
  CatalogError,
  CatalogService,
  type CatalogErrorReason,
  type PlaceDetails,
  type PlaceSchedule,
} from "./catalog.service.js";
export {
  canTransition,
  PLACE_TRANSITIONS,
  PUBLISH_PROBLEMS,
  publishProblems,
  SCHEDULE_PROBLEMS,
  scheduleProblems,
  type PlaceTransition,
  type PublishProblem,
  type ScheduleProblem,
} from "./catalog-rules.js";
export { isValidTimezone, RegionsAdminService } from "./regions-admin.service.js";
