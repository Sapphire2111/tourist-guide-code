import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { CatalogModule } from "../catalog/index.js";
import {
  BotApiTelegramSender,
  NotificationsService,
  TELEGRAM_SENDER,
  type TelegramSender,
} from "../host/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { RoleAssignmentsModule } from "../role-assignments/index.js";
import { ModerationController } from "./moderation.controller.js";
import { ModerationService } from "./moderation.service.js";
import { PartnerController } from "./partner.controller.js";
import { PARTNER_OPTIONS, type PartnerModuleOptions } from "./partner.options.js";
import { PartnerRepository } from "./partner.repository.js";
import { PartnerService } from "./partner.service.js";
import { PriceListController } from "./price-list.controller.js";
import { PriceListRepository } from "./price-list.repository.js";
import { PriceListService } from "./price-list.service.js";

/**
 * Кабинет партнёра (блок 6, ADR-0021): онбординг по шаблону, редактор заведения, модерация (AD02), сотрудники и
 * приглашения, акции, прайс (0030). Db — глобальный DatabaseModule; MediaService — глобальный MediaModule; уведомления — outbox
 * notifications блока 5 (свой экземпляр NotificationsService).
 */
@Module({})
export class PartnerModule {
  static forRoot(options: PartnerModuleOptions = {}): DynamicModule {
    return {
      module: PartnerModule,
      imports: [RbacModule, AuditModule, RegionsModule, RoleAssignmentsModule, CatalogModule],
      controllers: [PartnerController, PriceListController, ModerationController],
      providers: [
        { provide: PARTNER_OPTIONS, useValue: options },
        {
          provide: TELEGRAM_SENDER,
          useValue: (options.botToken
            ? new BotApiTelegramSender(options.botToken)
            : null) satisfies TelegramSender | null,
        },
        NotificationsService,
        PartnerRepository,
        PartnerService,
        ModerationService,
        PriceListRepository,
        PriceListService,
      ],
      exports: [PartnerService, ModerationService],
    };
  }
}
