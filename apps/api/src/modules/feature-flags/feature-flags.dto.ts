import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";
import type { FeatureFlagGateMark } from "../../db/index.js";
import { FEATURE_FLAG_KEYS, FINANCE_GATE_DECISIONS, type FeatureFlagKey } from "./catalog.js";
import type { FeatureFlagState } from "./feature-flags.service.js";

// DTO фича-флагов (T1-22). Ключи флагов — перечисление FeatureFlagKey в OpenAPI (тип для фронтендов).

export class FeatureFlagsQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Регион; без него — значения уровня окружения",
  })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}

export class FeatureFlagValueDto {
  @ApiProperty({ enum: FEATURE_FLAG_KEYS, enumName: "FeatureFlagKey" }) key!: FeatureFlagKey;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
}

export class FeatureFlagsDto {
  @ApiProperty({ type: String, format: "uuid", nullable: true }) regionId!: string | null;
  @ApiProperty({ type: [FeatureFlagValueDto] }) items!: FeatureFlagValueDto[];
}

export class FeatureFlagRegionOverrideDto {
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: Boolean }) enabled!: boolean;
}

export class FeatureFlagStateDto {
  @ApiProperty({ enum: FEATURE_FLAG_KEYS, enumName: "FeatureFlagKey" }) key!: FeatureFlagKey;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ enum: FEATURE_FLAG_KEYS, enumName: "FeatureFlagKey", isArray: true })
  requires!: FeatureFlagKey[];
  @ApiProperty({ type: Boolean, description: "Финансовый гейт: в prod включает только SUPERADMIN (D-81)" })
  financeGate!: boolean;
  @ApiProperty({ type: Boolean, description: "Значение по умолчанию в этом окружении" }) default!: boolean;
  @ApiProperty({ type: Boolean, nullable: true, description: "Переопределение на всё окружение" })
  override!: boolean | null;
  @ApiProperty({ type: [FeatureFlagRegionOverrideDto] }) regionOverrides!: FeatureFlagRegionOverrideDto[];
  @ApiProperty({ type: Boolean, description: "Эффективное значение уровня окружения (с учётом requires)" })
  effective!: boolean;
}

export class FeatureFlagStatesDto {
  @ApiProperty({ type: String, enum: ["local", "staging", "prod"] }) appEnv!: string;
  @ApiProperty({ type: [FeatureFlagStateDto] }) items!: FeatureFlagStateDto[];
}

export class SetFeatureFlagDto {
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: "true/false — переопределить; null — вернуть значение по умолчанию окружения",
  })
  @ValidateIf((_o, v) => v !== null)
  @IsBoolean()
  enabled!: boolean | null;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Регион; без него — всё окружение",
  })
  @IsOptional()
  @IsUUID()
  regionId?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 1000, description: "Причина (в аудит)" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class GateMarkDto {
  @ApiProperty({ type: String, enum: FINANCE_GATE_DECISIONS }) decision!: string;
  @ApiProperty({ type: String, description: "Ссылка на заключение юриста/бухгалтера и решение PO" })
  documentRef!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) markedBy!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) markedAt!: string;
}

export class GateMarksDto {
  @ApiProperty({
    type: String,
    enum: FINANCE_GATE_DECISIONS,
    isArray: true,
    description: "Что нужно отметить",
  })
  required!: string[];
  @ApiProperty({ type: [GateMarkDto] }) items!: GateMarkDto[];
}

export class CreateGateMarkDto {
  @ApiProperty({ type: String, enum: FINANCE_GATE_DECISIONS })
  @IsIn(FINANCE_GATE_DECISIONS)
  decision!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 1000 })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(/\S/)
  documentRef!: string;

  @ApiPropertyOptional({ type: String, maxLength: 1000, description: "Причина (в аудит)" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export function toFeatureFlagStateDto(s: FeatureFlagState): FeatureFlagStateDto {
  return { ...s, requires: [...s.requires] };
}

export function toGateMarkDto(m: FeatureFlagGateMark): GateMarkDto {
  return {
    decision: m.decision,
    documentRef: m.document_ref,
    markedBy: m.marked_by,
    markedAt: m.marked_at.toISOString(),
  };
}
