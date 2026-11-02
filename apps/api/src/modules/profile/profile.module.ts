import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { UsersModule } from "../users/index.js";
import { ProfileController } from "./profile.controller.js";
import {
  ConsentsRepository,
  MessagingConsentsRepository,
  PrivacyRequestsRepository,
} from "./profile.repositories.js";
import { ProfileService } from "./profile.service.js";

/**
 * Профиль (блок 2, C15): GET/PATCH /me, согласия, разрешение боту писать, запросы экспорта/удаления (каркас).
 * Сессия и @RequireAuth — из глобального AuthModule; Db — из глобального DatabaseModule.
 */
@Module({
  imports: [AuditModule, UsersModule],
  controllers: [ProfileController],
  providers: [ProfileService, ConsentsRepository, MessagingConsentsRepository, PrivacyRequestsRepository],
  exports: [ProfileService, ConsentsRepository, MessagingConsentsRepository, PrivacyRequestsRepository],
})
export class ProfileModule {}
