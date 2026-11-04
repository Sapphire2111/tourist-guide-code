import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import {
  createPlannerMessages,
  PLANNER_AI_CONFIG,
  PLANNER_AI_MESSAGES,
  PlannerAi,
  type PlannerAiConfig,
} from "./plan-ai.service.js";
import { AdminScenariosController, ScenariosController, UserPlansController } from "./planner.controller.js";
import { PlannerRepository } from "./planner.repository.js";
import { PlannerService } from "./planner.service.js";

/**
 * Планировщик «Мій план» (блок 5, ADR-0020): сценарии, планы пользователя, админка сценариев. forRoot — с живым
 * планом через Claude (флаг planner.ai, ключ ANTHROPIC_API_KEY); без forRoot — только правиловый план.
 */
@Module({
  imports: [RbacModule, AuditModule, RegionsModule],
  controllers: [ScenariosController, UserPlansController, AdminScenariosController],
  providers: [PlannerRepository, PlannerService],
  exports: [PlannerService],
})
export class PlannerModule {
  static forRoot(ai: PlannerAiConfig): DynamicModule {
    return {
      module: PlannerModule,
      providers: [
        { provide: PLANNER_AI_CONFIG, useValue: ai },
        { provide: PLANNER_AI_MESSAGES, useFactory: () => createPlannerMessages(ai.anthropicApiKey) },
        PlannerAi,
      ],
    };
  }
}
