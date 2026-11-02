// Сценарий-заглушка: проверяет, что каркас нагрузки работает против GET /health.
// Порог p95 — бюджет API из ТЗ §13 (p95 поиска ≤600 мс) как верхняя граница; ошибок — 0.
export default {
  name: "health",
  requests: [{ method: "GET", path: "/health" }],
  load: { connections: 10, duration: 5 },
  thresholds: { p95Ms: 600, maxErrorRate: 0 },
};
