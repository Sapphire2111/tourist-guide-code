import {
  applyDecorators,
  Injectable,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from "@nestjs/common";
import { tap, type Observable } from "rxjs";
import type { HttpResponse } from "./correlation-id.js";

/**
 * Интерсептор `Cache-Control: public, max-age=N` только для успешного ответа: заголовок ставится после обработчика,
 * когда он вернул значение. Ошибка (400/404/429/500) до ответа не доходит — её отдаёт ErrorEnvelopeFilter с
 * `no-store` (в отличие от @Header, который ставил бы публичный кеш и на ошибки).
 */
function publicCacheInterceptor(maxAgeSec: number): Type<NestInterceptor> {
  @Injectable()
  class PublicCacheInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      const res = context.switchToHttp().getResponse<HttpResponse>();
      return next.handle().pipe(
        tap(() => {
          if (!res.headersSent) res.setHeader("Cache-Control", `public, max-age=${maxAgeSec}`);
        }),
      );
    }
  }
  return PublicCacheInterceptor;
}

/** Публичный кеш успешного ответа на `maxAgeSec` секунд (данные одинаковы для всех, без ПДн). */
export function PublicCache(maxAgeSec: number): MethodDecorator & ClassDecorator {
  return applyDecorators(UseInterceptors(publicCacheInterceptor(maxAgeSec)));
}
