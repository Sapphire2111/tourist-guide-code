import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import {
  BotApiTelegramSender,
  NotificationsService,
  TELEGRAM_SENDER,
  type TelegramSender,
} from "../host/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { BookingsController, PartnerBookingsController, ResourcesController } from "./bookings.controller.js";
import { BookingsRepository } from "./bookings.repository.js";
import { BookingsService } from "./bookings.service.js";

export type BookingsModuleOptions = {
  /** TELEGRAM_BOT_TOKEN: уведомления о бронях ботом; без него — строки notifications со статусом skipped. */
  botToken?: string;
};

/**
 * Бронирования (блок 7): ресурсы и правила доступности, слоты, онлайн-бронь туриста, ручные записи и статусы
 * партнёра. Db — глобальный DatabaseModule; AnalyticsService — глобальный AnalyticsModule (события booking_*);
 * уведомления — outbox notifications блока 5 (свой экземпляр NotificationsService). Сроки (expired по SLA,
 * автозавершение) — задача воркера bookings.process-due.
 */
@Module({})
export class BookingsModule {
  static forRoot(options: BookingsModuleOptions = {}): DynamicModule {
    return {
      module: BookingsModule,
      imports: [RbacModule, AuditModule, RegionsModule],
      controllers: [ResourcesController, BookingsController, PartnerBookingsController],
      providers: [
        {
          provide: TELEGRAM_SENDER,
          useValue: (options.botToken
            ? new BotApiTelegramSender(options.botToken)
            : null) satisfies TelegramSender | null,
        },
        NotificationsService,
        BookingsRepository,
        BookingsService,
      ],
      exports: [BookingsService],
    };
  }
}
