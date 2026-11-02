import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import {
  AdminEmergencyContactsController,
  PublicEmergencyContactsController,
} from "./emergency-contacts.controller.js";
import { EmergencyContactsRepository } from "./emergency-contacts.repository.js";
import { EmergencyContactsService } from "./emergency-contacts.service.js";

/**
 * Экстренные контакты «Халепа?» (блок 3 — админка, блок 4 — экран туриста; ADR-0018): /admin/emergency-contacts
 * и публичный GET /regions/{regionId}/emergency-contacts. Db — глобальный DatabaseModule.
 */
@Module({
  imports: [RbacModule, AuditModule, RegionsModule],
  controllers: [AdminEmergencyContactsController, PublicEmergencyContactsController],
  providers: [EmergencyContactsRepository, EmergencyContactsService],
  exports: [EmergencyContactsRepository, EmergencyContactsService],
})
export class EmergencyContactsModule {}
