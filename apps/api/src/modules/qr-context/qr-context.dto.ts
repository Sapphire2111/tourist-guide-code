import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ENTRY_TYPES,
  QR_POINT_TYPES,
  QR_SCAN_RESULTS,
  type EntryType,
  type QrPointType,
} from "../../db/index.js";
import type { QrContextResult, QrContextStatus } from "./qr-context.service.js";

/** Статусы ответа: результаты скана (как в журнале) + default — открытие без QR (в журнал сканов не пишется). */
export const QR_CONTEXT_STATUSES = [...QR_SCAN_RESULTS, "default"] as const;

// Ответ GET /context и GET /context/{start_param} (ADR-0016). Мультиязычные поля — объект «язык → текст» (uk обязателен);
// язык выбирает клиент (pickLocalized из @tg/i18n).

export class QrLocalizedTextDto {
  @ApiProperty({ type: String, description: "Текст на украинском (обязателен)" })
  uk!: string;

  @ApiPropertyOptional({ type: String })
  en?: string;
}

export class ContextRegionDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, example: "test-region" })
  code!: string;

  @ApiProperty({ type: QrLocalizedTextDto })
  name!: QrLocalizedTextDto;

  @ApiProperty({ type: String, example: "Europe/Kyiv", description: "IANA-зона региона" })
  timezone!: string;

  @ApiProperty({ type: String, example: "uk" })
  defaultLanguage!: string;
}

export class ContextQrPointDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ enum: QR_POINT_TYPES, enumName: "QrPointType" })
  type!: QrPointType;

  @ApiProperty({ type: String, format: "uuid", nullable: true, description: "Место каталога (с блока 3)" })
  placeId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Метка кампании" })
  campaign!: string | null;
}

/** Экран «Про заклад» (C03) для QR отеля. */
export class ContextVenueDto {
  @ApiProperty({ type: QrLocalizedTextDto })
  name!: QrLocalizedTextDto;

  @ApiProperty({ type: QrLocalizedTextDto, nullable: true })
  description!: QrLocalizedTextDto | null;

  @ApiProperty({ type: QrLocalizedTextDto, nullable: true })
  address!: QrLocalizedTextDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "+380501234567",
    description: "Телефон заклада, E.164",
  })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "https://hotel.example", description: "Сайт, https" })
  website!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "test_hotel", description: "Telegram без @" })
  telegram!: string | null;
}

export class QrContextDto {
  @ApiProperty({
    enum: QR_CONTEXT_STATUSES,
    enumName: "QrContextStatus",
    description:
      "ok — активная точка; inactive — точка деактивирована; not_found — кода нет; invalid — параметр не по формату; " +
      "default — открытие без QR (GET /context). Кроме ok — нейтральный контекст региона (экран выбора места C18).",
  })
  status!: QrContextStatus;

  @ApiProperty({ enum: ENTRY_TYPES, enumName: "EntryType", description: "Тип точки при ok, иначе default" })
  entryType!: EntryType;

  @ApiProperty({
    type: ContextRegionDto,
    nullable: true,
    description: "null — в платформе нет активного региона",
  })
  region!: ContextRegionDto | null;

  @ApiProperty({ type: ContextQrPointDto, nullable: true, description: "Только при ok" })
  qrPoint!: ContextQrPointDto | null;

  @ApiProperty({
    type: ContextVenueDto,
    nullable: true,
    description: "«Про заклад» — только при ok у QR отеля",
  })
  venue!: ContextVenueDto | null;

  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description: "EntryContext — передавать в конверте аналитики (entryContextId)",
  })
  entryContextId!: string | null;

  @ApiProperty({
    type: String,
    format: "uuid",
    description:
      "Анонимный id устройства: присланный или новый — хранить и слать в аналитике и следующих запросах",
  })
  anonymousId!: string;
}

export function toQrContextDto(r: QrContextResult): QrContextDto {
  return {
    status: r.status,
    entryType: r.entryType,
    region: r.region
      ? {
          id: r.region.id,
          code: r.region.code,
          name: r.region.name_i18n,
          timezone: r.region.timezone,
          defaultLanguage: r.region.default_language,
        }
      : null,
    qrPoint: r.point,
    venue: r.venue,
    entryContextId: r.entryContextId,
    anonymousId: r.anonymousId,
  };
}
