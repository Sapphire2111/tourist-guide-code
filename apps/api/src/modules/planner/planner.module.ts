import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { AdminScenariosController, ScenariosController, UserPlansController } from "./planner.controller.js";
import { PlannerRepository } from "./planner.repository.js";
import { PlannerService } from "./planner.service.js";

/** Планировщик «Мій план» (блок 5, ADR-0020): сценарии, планы пользователя, админка сценариев. */
@Module({
  imports: [RbacModule, AuditModule, RegionsModule],
  controllers: [ScenariosController, UserPlansController, AdminScenariosController],
  providers: [PlannerRepository, PlannerService],
  exports: [PlannerService],
})
export class PlannerModule {}
