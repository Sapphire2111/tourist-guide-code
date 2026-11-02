// Публичный интерфейс контекста feature-flags (T1-22): каталог флагов, эффективные значения, @RequireFeature.
export { FeatureFlagsModule, type FeatureFlagsModuleOptions } from "./feature-flags.module.js";
export {
  evaluateFlags,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,
  FINANCE_GATE_DECISIONS,
  FINANCE_GATE_ROLE,
  isFeatureFlagKey,
  type FeatureFlagDefinition,
  type FeatureFlagKey,
  type FinanceGateDecision,
  type FlagOverrides,
} from "./catalog.js";
export {
  FEATURE_FLAG_AUDIT_ACTIONS,
  FEATURE_FLAG_ENTITY,
  FEATURE_FLAG_GATE_ENTITY,
  FEATURE_FLAGS_APP_ENV,
  FeatureFlagError,
  FeatureFlagsService,
  type FeatureFlagErrorReason,
  type FeatureFlagState,
  type GateMarkInput,
  type SetFlagInput,
} from "./feature-flags.service.js";
export { FeatureFlagsRepository } from "./feature-flags.repository.js";
export {
  FeatureAccess,
  FeatureGuard,
  regionFromParam,
  RequireFeature,
  type FeatureRegionResolveArgs,
  type FeatureRegionResolver,
  type RequireFeatureOptions,
} from "./feature.guard.js";
