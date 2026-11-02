import { Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { ModerationCaseStatus, ModerationDecision, VerificationMethod } from "../../db/index.js";
import type { ModerationCaseDetailDto, ModerationCaseDto, ModerationCaseListDto } from "./partner.dto.js";
import type { AuditMeta } from "./partner.service.js";

export type ModerationDecisionInput = {
  decision: ModerationDecision;
  comment?: string;
  verificationMethod?: VerificationMethod;
};

const todo = (): never => {
  throw new ApiError("SERVICE_UNAVAILABLE", { details: { reason: "not_implemented" } });
};

/** Модерация мест партнёров (AD02). Контракт; реализация — следующим коммитом. */
@Injectable()
export class ModerationService {
  list(_u: string, _f: { status: ModerationCaseStatus; regionId?: string }): Promise<ModerationCaseListDto> {
    return todo();
  }
  get(_u: string, _id: string): Promise<ModerationCaseDetailDto> {
    return todo();
  }
  decide(_u: string, _id: string, _i: ModerationDecisionInput, _m: AuditMeta): Promise<ModerationCaseDto> {
    return todo();
  }
}
