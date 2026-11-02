import { Module } from "@nestjs/common";
import { QrContextController } from "./qr-context.controller.js";
import { QrContextRepository } from "./qr-context.repository.js";
import { QrContextService } from "./qr-context.service.js";

/**
 * QR-контекст входа (блок 2, ADR-0016): GET /context/{start_param}. Db — глобальный DatabaseModule,
 * AnalyticsService — глобальный AnalyticsModule.forRoot (без него приложение не соберётся: событие qr_scanned).
 */
@Module({
  controllers: [QrContextController],
  providers: [QrContextRepository, QrContextService],
  exports: [QrContextRepository, QrContextService],
})
export class QrContextModule {}
