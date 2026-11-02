import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

// Мультиязычный текст в теле запроса (CHECK is_localized_text: uk обязателен). Языки кроме uk и en — с i18n
// (D-05); лишние ключи отклоняет ValidationPipe (forbidNonWhitelisted).

/** Короткий текст (название, заголовок): до 200 символов. */
export class LocalizedNameDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  uk!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  en?: string;
}

/** Длинный текст (описание, адрес): до 2000 символов. */
export class LocalizedDescriptionDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  uk!: string;

  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  en?: string;
}

/** Мультиязычный текст в ответе: объект «язык → текст», uk есть всегда. */
export class LocalizedTextDto {
  @ApiProperty({ type: String, description: "Текст на украинском (обязателен)" })
  uk!: string;

  @ApiPropertyOptional({ type: String })
  en?: string;
}

/** Текст из DTO → объект для jsonb (только заданные языки; пустые строки отсекает валидация). */
export function toLocalized(dto: { uk: string; en?: string }): { uk: string; en?: string } {
  return dto.en === undefined ? { uk: dto.uk.trim() } : { uk: dto.uk.trim(), en: dto.en.trim() };
}
