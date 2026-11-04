// Публичный интерфейс контекста reviews (блок 10, подтверждённые отзывы).
export { COMPLAINT_RATE_LIMIT, REVIEW_RATE_LIMIT } from "./reviews.controller.js";
export * from "./reviews.dto.js";
export { ReviewsModule } from "./reviews.module.js";
export { ReviewsRepository } from "./reviews.repository.js";
export { REVIEW_AUDIT, REVIEW_ENTITY, ReviewsService, type ReviewAuditMeta } from "./reviews.service.js";
export * from "./review-rules.js";
