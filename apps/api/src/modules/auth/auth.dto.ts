import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from "class-validator";
import {
  SCOPE_TYPES,
  SESSION_CHANNELS,
  type ScopeType,
  type Session,
  type SessionChannel,
} from "../../db/index.js";
import type { Grant } from "../rbac/index.js";
import { CLIENT_PLATFORMS, type ClientPlatform } from "./telegram-auth.service.js";
import { INIT_DATA_MAX_LENGTH } from "./telegram-init-data.js";

// DTO API сессий (T1-26). Токен — только в ответе выдачи (IssuedSessionDto), в остальных ответах и логах его нет.

export class SessionGrantDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "TECH_REGION_ADMIN" }) role!: string;
  @ApiProperty({ enum: SCOPE_TYPES, enumName: "ScopeType" }) scopeType!: ScopeType;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) scopeId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) regionId!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) validUntil!: string | null;
}

export class SessionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ enum: SESSION_CHANNELS, enumName: "SessionChannel" }) channel!: SessionChannel;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description:
      "Выбранный регион режима партнёра/админа (D-50); null — не выбран (контекст выводится из назначений)",
  })
  activeRegionId!: string | null;
  @ApiProperty({ type: [SessionGrantDto], description: "Действующие назначения ролей пользователя" })
  grants!: SessionGrantDto[];
}

export class IssuedSessionDto {
  @ApiProperty({
    type: String,
    description: "Токен сессии для `Authorization: Bearer`; выдаётся один раз, сервер хранит только его хэш",
  })
  token!: string;
  @ApiProperty({ type: SessionDto }) session!: SessionDto;
}

export class SelectRegionDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Регион режима партнёра/админа; null — снять выбор",
  })
  // null допустим явно; отсутствие поля — ошибка валидации.
  @ValidateIf((o: SelectRegionDto) => o.regionId !== null)
  @IsUUID()
  regionId!: string | null;
}

/** Dev-вход (только APP_ENV=local и AUTH_DEV_LOGIN=true): сессия существующему пользователю без проверки личности. */
export class DevLoginDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "Сразу выбрать регион режима" })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}

export function toSessionDto(session: Session, grants: readonly Grant[]): SessionDto {
  return {
    id: session.id,
    userId: session.user_id,
    channel: session.channel,
    expiresAt: session.expires_at.toISOString(),
    activeRegionId: session.active_region_id,
    grants: grants.map((g) => ({
      id: g.id,
      role: g.role,
      scopeType: g.scopeType,
      scopeId: g.scopeId,
      regionId: g.regionId,
      validUntil: g.validUntil?.toISOString() ?? null,
    })),
  };
}

/** Вход через Telegram (блок 2): initData Mini App как есть (`Telegram.WebApp.initData`). */
export class TelegramLoginDto {
  @ApiProperty({
    type: String,
    maxLength: INIT_DATA_MAX_LENGTH,
    description:
      "Строка `Telegram.WebApp.initData` без изменений. ПДн: сервер проверяет подпись и не логирует её",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(INIT_DATA_MAX_LENGTH)
  initData!: string;

  @ApiPropertyOptional({
    enum: CLIENT_PLATFORMS,
    enumName: "ClientPlatform",
    description: "Платформа клиента (`Telegram.WebApp.platform`, приведённая) — для события app_opened",
  })
  @IsOptional()
  @IsIn(CLIENT_PLATFORMS)
  platform?: ClientPlatform;
}

export class TelegramLoginResponseDto extends IssuedSessionDto {
  @ApiProperty({
    type: Boolean,
    description: "Первый вход: пользователь только что создан (показать онбординг C01)",
  })
  isNewUser!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "start_param из initData как есть (параметр startapp ссылки/QR); разбор контекста — GET /context/{start_param}",
  })
  startParam!: string | null;
}
