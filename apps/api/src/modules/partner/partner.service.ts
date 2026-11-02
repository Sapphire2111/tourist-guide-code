import { Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { AuditEntry } from "../audit/index.js";
import type { MediaUploadDto } from "../media/index.js";
import type { OfferStatus, StaffInviteRole } from "../../db/index.js";
import type {
  CreateOfferDto,
  OfferDto,
  OfferListDto,
  PartnerMediaConfirmDto,
  PartnerMediaUploadRequestDto,
  PartnerMeDto,
  PartnerOnboardingDto,
  PartnerOnboardingResultDto,
  PartnerPlaceDto,
  PartnerStaffDto,
  PartnerStaffMemberDto,
  PartnerSubmitDto,
  PartnerTemplateListDto,
  StaffInviteAcceptedDto,
  StaffInviteCreatedDto,
  StaffInvitePreviewDto,
  UpdateOfferDto,
  UpdatePartnerPlaceDto,
} from "./partner.dto.js";
import type { PutScheduleDto } from "../catalog/index.js";

export type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

const todo = (): never => {
  throw new ApiError("SERVICE_UNAVAILABLE", { details: { reason: "not_implemented" } });
};

/** Кабинет партнёра (блок 6, ADR-0021). Контракт; реализация — следующим коммитом. */
@Injectable()
export class PartnerService {
  templates(_regionId: string): Promise<PartnerTemplateListDto> {
    return todo();
  }
  onboard(_u: string, _b: PartnerOnboardingDto, _m: AuditMeta): Promise<PartnerOnboardingResultDto> {
    return todo();
  }
  me(_u: string): Promise<PartnerMeDto> {
    return todo();
  }
  getPlace(_u: string, _id: string): Promise<PartnerPlaceDto> {
    return todo();
  }
  updatePlace(_u: string, _id: string, _b: UpdatePartnerPlaceDto, _m: AuditMeta): Promise<PartnerPlaceDto> {
    return todo();
  }
  putSchedule(_u: string, _id: string, _b: PutScheduleDto, _m: AuditMeta): Promise<PartnerPlaceDto> {
    return todo();
  }
  createMediaUpload(_u: string, _id: string, _b: PartnerMediaUploadRequestDto): Promise<MediaUploadDto> {
    return todo();
  }
  confirmMedia(
    _u: string,
    _id: string,
    _a: string,
    _b: PartnerMediaConfirmDto,
    _m: AuditMeta,
  ): Promise<PartnerPlaceDto> {
    return todo();
  }
  deleteMedia(_u: string, _id: string, _a: string, _m: AuditMeta): Promise<void> {
    return todo();
  }
  submit(_u: string, _id: string, _b: PartnerSubmitDto, _m: AuditMeta): Promise<PartnerPlaceDto> {
    return todo();
  }
  listOffers(_u: string, _id: string, _s?: OfferStatus): Promise<OfferListDto> {
    return todo();
  }
  createOffer(_u: string, _id: string, _b: CreateOfferDto, _m: AuditMeta): Promise<OfferDto> {
    return todo();
  }
  updateOffer(_u: string, _id: string, _o: string, _b: UpdateOfferDto, _m: AuditMeta): Promise<OfferDto> {
    return todo();
  }
  archiveOffer(_u: string, _id: string, _o: string, _m: AuditMeta): Promise<OfferDto> {
    return todo();
  }
  staff(_u: string, _org: string): Promise<PartnerStaffDto> {
    return todo();
  }
  createInvite(_u: string, _org: string, _r: StaffInviteRole, _m: AuditMeta): Promise<StaffInviteCreatedDto> {
    return todo();
  }
  revokeInvite(_u: string, _org: string, _i: string, _m: AuditMeta): Promise<void> {
    return todo();
  }
  changeRole(
    _u: string,
    _org: string,
    _a: string,
    _r: StaffInviteRole,
    _m: AuditMeta,
  ): Promise<PartnerStaffMemberDto> {
    return todo();
  }
  deactivate(_u: string, _org: string, _a: string, _m: AuditMeta): Promise<void> {
    return todo();
  }
  previewInvite(_u: string, _t: string): Promise<StaffInvitePreviewDto> {
    return todo();
  }
  acceptInvite(_u: string, _t: string, _m: AuditMeta): Promise<StaffInviteAcceptedDto> {
    return todo();
  }
}
