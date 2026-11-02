import { timingSafeEqual } from "node:crypto";
import { PROMETHEUS_CONTENT_TYPE, type MetricsRegistry } from "@tg/server-config";

// Минимальные структурные типы Express (без @types/express): то, что читает метрика.
type MetricsRequest = {
  method: string;
  path?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  headers: Record<string, string | string[] | undefined>;
};
type MetricsResponse = {
  statusCode: number;
  writableFinished?: boolean;
  on(event: "finish" | "close", cb: () => void): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): MetricsResponse;
  end(body?: string): unknown;
};

/**
 * RED по эндпоинтам (T1-18): `http_requests_total{method,route,status}` и
 * `http_request_duration_seconds{method,route}`. route — шаблон маршрута Express (`/regions/:id`),
 * а не фактический путь: без id и ПДн в метках и без взрыва кардинальности; не сопоставлен — `unmatched`.
 */
export function httpMetricsMiddleware(registry: MetricsRegistry) {
  const requests = registry.counter("http_requests_total", "HTTP-запросы по методу, маршруту и статусу");
  const errors = registry.counter("http_errors_total", "HTTP-ответы 5xx по методу и маршруту");
  const duration = registry.histogram("http_request_duration_seconds", "Длительность HTTP-запроса, с");
  return (req: MetricsRequest, res: MetricsResponse, next: () => void): void => {
    const start = process.hrtime.bigint();
    let done = false;
    const record = () => {
      if (done) return;
      done = true;
      const routePath =
        typeof req.route?.path === "string" ? `${req.baseUrl ?? ""}${req.route.path}` : "unmatched";
      const labels = { method: req.method, route: routePath };
      // close без finish — клиент оборвал запрос до конца ответа.
      const status = res.writableFinished === false ? "aborted" : String(res.statusCode);
      requests.inc({ ...labels, status });
      if (res.statusCode >= 500) errors.inc(labels);
      duration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    };
    res.on("finish", record);
    res.on("close", record);
    next();
  };
}

/**
 * GET /metrics в формате Prometheus. С токеном — только с `Authorization: Bearer <token>` (иначе 404,
 * чтобы не выдавать эндпоинт); без токена — открыт (local/staging; в prod без токена не подключается).
 */
export function metricsHandler(registry: MetricsRegistry, token?: string) {
  const expected = token ? Buffer.from(`Bearer ${token}`) : undefined;
  return (req: MetricsRequest, res: MetricsResponse, next: () => void): void => {
    // Смонтирован на /metrics: только GET и точный путь (`/metrics`, `/metrics/`), прочее — дальше по цепочке.
    if (req.method !== "GET" || (req.path !== undefined && req.path !== "/")) {
      next();
      return;
    }
    if (expected) {
      const got = Buffer.from(String(req.headers.authorization ?? ""));
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        res.status(404).end();
        return;
      }
    }
    res.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(registry.render());
  };
}
