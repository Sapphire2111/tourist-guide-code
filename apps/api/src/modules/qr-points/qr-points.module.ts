import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { QrPointsController } from "./qr-points.controller.js";
import { QrPointsRepository } from "./qr-points.repository.js";
import { QR_PRINT_OPTIONS, QrPointsService, type QrPrintOptions } from "./qr-points.service.js";

/**
 * QR-менеджмент админки (AD04, блок 3; ADR-0018): /admin/qr-points. Имя бота для ссылки печати —
 * TELEGRAM_BOT_USERNAME (необязательно: без него печать отвечает 409). Db — глобальный DatabaseModule.
 */
@Module({})
export class QrPointsModule {
  static forRoot(opts: QrPrintOptions = {}): DynamicModule {
    return {
      module: QrPointsModule,
      imports: [RbacModule, AuditModule],
      controllers: [QrPointsController],
      providers: [
        QrPointsRepository,
        QrPointsService,
        { provide: QR_PRINT_OPTIONS, useValue: { botUsername: opts.botUsername || undefined } },
      ],
      exports: [QrPointsRepository, QrPointsService],
    };
  }
}
