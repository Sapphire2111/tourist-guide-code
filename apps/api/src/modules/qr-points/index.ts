// Публичный интерфейс контекста qr-points (блок 3, AD04; ADR-0018): QR-менеджмент админки.
export {
  AdminQrPointDto,
  CreateQrPointDto,
  QrPointPrintDto,
  QrPointsQueryDto,
  toAdminQrPointDto,
  UpdateQrPointDto,
} from "./qr-points.dto.js";
export { QrPointsController } from "./qr-points.controller.js";
export { QrPointsModule } from "./qr-points.module.js";
export { QrPointsRepository, type QrPointFilter } from "./qr-points.repository.js";
export {
  buildDeepLink,
  QR_POINT_AUDIT,
  QR_POINT_ENTITY,
  QR_PRINT_OPTIONS,
  QrPointError,
  QrPointsService,
  renderQrSvg,
  type CreateQrPointInput,
  type QrPrintOptions,
  type QrVenueInput,
  type UpdateQrPointInput,
} from "./qr-points.service.js";
