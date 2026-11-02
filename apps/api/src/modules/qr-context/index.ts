// Публичный интерфейс контекста qr-context (блок 2, ADR-0016).
export { QR_CONTEXT_RATE_LIMIT, QrContextController } from "./qr-context.controller.js";
export { QrContextDto, toQrContextDto } from "./qr-context.dto.js";
export { QrContextModule } from "./qr-context.module.js";
export { QrContextRepository, type ContextRegion, type ResolvedQrPoint } from "./qr-context.repository.js";
export {
  DEFAULT_CONTEXT_REGION_CODE,
  QrContextService,
  type QrContextInput,
  type QrContextResult,
  type QrVenue,
} from "./qr-context.service.js";
export {
  QR_CODE_GENERATED_LENGTH,
  QR_CODE_MAX_LENGTH,
  QR_CODE_MIN_LENGTH,
  QR_CODE_RE,
  checkStartParam,
  generateQrCode,
  type StartParamCheck,
} from "./start-param.js";
