import { applyDecorators, type Type } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiHeader,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from "@nestjs/swagger";
import { Type as TransformType } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { CORRELATION_ID_HEADER, ERROR_CODES, ERROR_HTTP_STATUS, type ErrorCode } from "@tg/shared";

// OpenAPI-описания общего контракта (T1-17). Типы-источники — в @tg/shared.
// Тип каждого свойства указан явно: не полагаемся на design:type (скрипт спеки и SWC/tsc дают одно и то же).

export class FieldErrorDto {
  @ApiProperty({ type: String, example: "email" }) field!: string;
  @ApiProperty({ type: String, example: "errors.validation.isEmail" }) messageKey!: string;
  @ApiProperty({ type: String, example: "isEmail" }) constraint!: string;
}

export class ErrorDetailsDto {
  @ApiPropertyOptional({ type: [FieldErrorDto], description: "Ошибки полей (VALIDATION_FAILED)" })
  fields?: FieldErrorDto[];
}

export class ErrorBodyDto {
  @ApiProperty({ enum: ERROR_CODES, enumName: "ErrorCode" }) code!: ErrorCode;
  @ApiProperty({ type: String, description: "Ключ i18n сообщения", example: "errors.validation" })
  messageKey!: string;
  @ApiPropertyOptional({ type: ErrorDetailsDto }) details?: ErrorDetailsDto;
  @ApiProperty({ type: String, description: "Совпадает с заголовком X-Request-Id ответа" })
  correlationId!: string;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
}

/**
 * Схема безопасности OpenAPI: токен сессии в `Authorization: Bearer` (T1-26, ADR-0009). Регистрирует
 * buildOpenApiDocument; эндпоинты помечают @RequirePermission и @RequireAuth.
 */
export const SESSION_SECURITY = "session";

const CORRELATION_HEADER_DOC = {
  [CORRELATION_ID_HEADER]: { description: "Correlation id запроса", schema: { type: "string" } },
};

/** Ответы-ошибки эндпоинта в едином конверте (400 и 500 возможны всегда и добавляются автоматически). */
export function ApiErrors(...codes: ErrorCode[]): MethodDecorator & ClassDecorator {
  const statuses = new Set<number>([ERROR_HTTP_STATUS.BAD_REQUEST, ERROR_HTTP_STATUS.INTERNAL]);
  for (const c of codes) statuses.add(ERROR_HTTP_STATUS[c]);
  return applyDecorators(
    ApiHeader({ name: "X-Request-Id", required: false, description: "Correlation id; иначе генерируется" }),
    ...[...statuses]
      .sort((a, b) => a - b)
      .map((status) =>
        ApiResponse({
          status,
          description: "Ошибка",
          type: ErrorEnvelopeDto,
          headers: CORRELATION_HEADER_DOC,
        }),
      ),
  );
}

/** Query-параметры курсорной пагинации. */
export class CursorQueryDto {
  @ApiPropertyOptional({ type: String, description: "Курсор из nextCursor предыдущей страницы" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @TransformType(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Ответ 200 со страницей `{ items: Item[], nextCursor: string | null }` (тип CursorPage из @tg/shared). */
export function ApiCursorPage(item: Type<unknown>): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(item),
    ApiResponse({
      status: 200,
      description: "Страница списка",
      schema: {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: { $ref: getSchemaPath(item) } },
          nextCursor: { type: "string", nullable: true },
        },
      },
    }),
  );
}

/** Деньги: целые минимальные единицы + ISO 4217 (тип Money из @tg/shared). */
export class MoneyDto {
  @ApiProperty({ type: "integer", example: 12550, description: "Сумма в минимальных единицах (копейках)" })
  amountMinor!: number;
  @ApiProperty({ type: String, example: "UAH", pattern: "^[A-Z]{3}$" }) currency!: string;
}
