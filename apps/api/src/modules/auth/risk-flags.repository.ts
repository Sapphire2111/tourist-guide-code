import { Injectable } from "@nestjs/common";
import { currentDb, InjectDb, type Db, type NewRiskFlag, type RiskFlag } from "../../db/index.js";

/**
 * Доступ к risk_flags (tenant-optional, миграция 0010). Признак без региона (отказ во входе) пишется только в
 * SYSTEM/PLATFORM-контексте (withTenant(SYSTEM_CONTEXT)). details — без ПДн: коды и id.
 */
@Injectable()
export class RiskFlagsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  create(flag: NewRiskFlag): Promise<RiskFlag> {
    return currentDb(this.db).insertInto("risk_flags").values(flag).returningAll().executeTakeFirstOrThrow();
  }
}
