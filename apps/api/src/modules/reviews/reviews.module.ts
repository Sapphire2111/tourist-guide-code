import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import {
  AdminReviewsController,
  AppealsController,
  PartnerReviewsController,
  ReviewsController,
} from "./reviews.controller.js";
import { ReviewsRepository } from "./reviews.repository.js";
import { ReviewsService } from "./reviews.service.js";

/**
 * Подтверждённые отзывы (блок 10, облегчённая версия): право на отзыв из завершённой брони (триггер БД 0028), отзыв
 * с версиями, автофильтр и постмодерация, ответ партнёра, жалобы, апелляции, рейтинг D-37. Db — глобальный
 * DatabaseModule; FeatureFlagsService и AnalyticsService (события review_*) — глобальные модули. За флагом
 * module.reviews (по умолчанию выключен).
 */
@Module({
  imports: [RbacModule, AuditModule, RegionsModule],
  controllers: [ReviewsController, AppealsController, PartnerReviewsController, AdminReviewsController],
  providers: [ReviewsRepository, ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
