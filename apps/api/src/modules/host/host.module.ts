import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { RoleAssignmentsModule } from "../role-assignments/index.js";
import {
  AdminHostModuleController,
  AdminPlaceStaffController,
  HostModuleController,
  MyServiceRequestsController,
  ServiceRequestsController,
  StaffServiceRequestsController,
} from "./host.controller.js";
import { HostRepository } from "./host.repository.js";
import { HostService } from "./host.service.js";
import {
  BotApiTelegramSender,
  NotificationsService,
  TELEGRAM_SENDER,
  type TelegramSender,
} from "./notifications.js";

export type HostModuleOptions = {
  /** TELEGRAM_BOT_TOKEN: уведомления персоналу и гостю ботом; без него — строки notifications со статусом skipped. */
  botToken?: string;
};

/**
 * Заявки гостиницы и «Про заклад» (блок 5, ADR-0020): гость (C03, C22), персонал (P10), админка (настройки и
 * персонал места), уведомления ботом (outbox notifications). Db — глобальный DatabaseModule.
 */
@Module({})
export class HostRequestsModule {
  static forRoot(options: HostModuleOptions = {}): DynamicModule {
    return {
      module: HostRequestsModule,
      imports: [RbacModule, AuditModule, RegionsModule, RoleAssignmentsModule],
      controllers: [
        HostModuleController,
        ServiceRequestsController,
        MyServiceRequestsController,
        StaffServiceRequestsController,
        AdminHostModuleController,
        AdminPlaceStaffController,
      ],
      providers: [
        {
          provide: TELEGRAM_SENDER,
          useValue: (options.botToken
            ? new BotApiTelegramSender(options.botToken)
            : null) satisfies TelegramSender | null,
        },
        HostRepository,
        HostService,
        NotificationsService,
      ],
      exports: [HostService, NotificationsService],
    };
  }
}
