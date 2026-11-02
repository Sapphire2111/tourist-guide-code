import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { LocalizedDescriptionDto, LocalizedNameDto, LocalizedTextDto } from "../../common/http/index.js";
import { EMERGENCY_CONTACT_KINDS, type EmergencyContact, type EmergencyContactKind } from "../../db/index.js";

// DTO экстренных контактов «Халепа?» (блок 3/4; ADR-0018). Формат телефона — как CHECK миграции 0013.

/** E.164 (+380…) или короткий номер экстренной службы (112, 101, 102, 103). */
export const EMERGENCY_PHONE_RE = /^(\+[1-9][0-9]{6,14}|[0-9]{2,6})$/;

export class CreateEmergencyContactDto {
  @ApiProperty({ enum: EMERGENCY_CONTACT_KINDS, enumName: "EmergencyContactKind" })
  @IsIn(EMERGENCY_CONTACT_KINDS)
  kind!: EmergencyContactKind;

  @ApiProperty({ type: LocalizedNameDto })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @ApiProperty({ type: String, example: "112", description: "E.164 или короткий номер службы (2–6 цифр)" })
  @Matches(EMERGENCY_PHONE_RE)
  phone!: string;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  description?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 10000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateEmergencyContactDto {
  @ApiPropertyOptional({ enum: EMERGENCY_CONTACT_KINDS, enumName: "EmergencyContactKind" })
  @IsOptional()
  @IsIn(EMERGENCY_CONTACT_KINDS)
  kind?: EmergencyContactKind;

  @ApiPropertyOptional({ type: LocalizedNameDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @ApiPropertyOptional({ type: String, example: "+380501234567" })
  @IsOptional()
  @Matches(EMERGENCY_PHONE_RE)
  phone?: string;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true, description: "null — убрать" })
  @ValidateIf((o: UpdateEmergencyContactDto) => o.description !== undefined && o.description !== null)
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  description?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class EmergencyContactsQueryDto {
  @ApiPropertyOptional({ enum: EMERGENCY_CONTACT_KINDS, enumName: "EmergencyContactKind" })
  @IsOptional()
  @IsIn(EMERGENCY_CONTACT_KINDS)
  kind?: EmergencyContactKind;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === "true" ? true : value === "false" ? false : value))
  @IsBoolean()
  active?: boolean;
}

/** Контакт для туриста (экран «Халепа?»). */
export class EmergencyContactDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: EMERGENCY_CONTACT_KINDS, enumName: "EmergencyContactKind" })
  kind!: EmergencyContactKind;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ type: String, example: "112", description: "Номер для tel: — как есть" }) phone!: string;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
}

/** Контакт в админке: плюс регион, активность и время изменения. */
export class AdminEmergencyContactDto extends EmergencyContactDto {
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class EmergencyContactListDto {
  @ApiProperty({ type: [EmergencyContactDto] }) items!: EmergencyContactDto[];
}

export class AdminEmergencyContactListDto {
  @ApiProperty({ type: [AdminEmergencyContactDto], description: "По порядку показа; до 200 записей" })
  items!: AdminEmergencyContactDto[];
}

export function toEmergencyContactDto(row: EmergencyContact): EmergencyContactDto {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name_i18n,
    phone: row.phone,
    description: row.description_i18n,
    sortOrder: row.sort_order,
  };
}

export function toAdminEmergencyContactDto(row: EmergencyContact): AdminEmergencyContactDto {
  return {
    ...toEmergencyContactDto(row),
    regionId: row.region_id,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
