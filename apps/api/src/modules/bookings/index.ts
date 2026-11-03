// Публичный интерфейс контекста bookings (блок 7, бронирования).
export { BOOKING_RATE_LIMIT, MANUAL_BOOKING_RATE_LIMIT } from "./bookings.controller.js";
export * from "./bookings.dto.js";
export { BookingsModule, type BookingsModuleOptions } from "./bookings.module.js";
export { BookingsRepository } from "./bookings.repository.js";
export {
  BOOKING_AUDIT,
  BOOKING_ENTITY,
  BOOKING_NOTIFICATIONS,
  BookingsService,
  PHONE_SHARE_CONSENT_VERSION,
  RESOURCE_ENTITY,
  type BookingAuditMeta,
} from "./bookings.service.js";
export * from "./booking-rules.js";
