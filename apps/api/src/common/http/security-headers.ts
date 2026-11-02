import type { AppEnv } from "@tg/server-config";

type Req = { path?: string; url?: string };
type Res = { setHeader(name: string, value: string): unknown };

/** API отдаёт только JSON: ничего не грузить, не встраиваться во фреймы. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Swagger UI (/docs, только local/staging): скрипты и стили swagger-ui-dist с того же origin плюс inline-инициализация,
 * картинки data:. Запросы «Try it out» — на тот же origin.
 */
export const DOCS_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** HSTS на год с поддоменами; только за HTTPS (staging/prod на Render), в local не выставляется. */
export const HSTS = "max-age=31536000; includeSubDomains";

/**
 * Заголовки безопасности (T1-24, ТЗ §13) без сторонней зависимости: nosniff, запрет фреймов (CSP frame-ancestors и
 * X-Frame-Options для старых браузеров), Referrer-Policy, CSP (строгая для JSON, мягче для /docs), HSTS вне local.
 */
export function securityHeadersMiddleware(appEnv: AppEnv) {
  const hsts = appEnv !== "local";
  return (req: Req, res: Res, next: () => void): void => {
    const path = req.path ?? req.url ?? "";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      path === "/docs" || path.startsWith("/docs/") ? DOCS_CSP : API_CSP,
    );
    if (hsts) res.setHeader("Strict-Transport-Security", HSTS);
    next();
  };
}
