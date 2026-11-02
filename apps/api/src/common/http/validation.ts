import { ValidationPipe, type ValidationError } from "@nestjs/common";
import type { FieldError } from "@tg/shared";
import { ApiError } from "./api-error.js";

/** Плоский список ошибок полей; вложенные DTO дают путь через точку. */
export function toFieldErrors(errors: ValidationError[], prefix = ""): FieldError[] {
  return errors.flatMap((e) => {
    const field = prefix + e.property;
    const own = Object.keys(e.constraints ?? {}).map((constraint) => ({
      field,
      constraint,
      messageKey: `errors.validation.${constraint}`,
    }));
    return [...own, ...toFieldErrors(e.children ?? [], `${field}.`)];
  });
}

/** Глобальная валидация DTO (class-validator): лишние поля запрещены, ошибки → 400 VALIDATION_FAILED. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors) =>
      new ApiError("VALIDATION_FAILED", { details: { fields: toFieldErrors(errors) } }),
  });
}
