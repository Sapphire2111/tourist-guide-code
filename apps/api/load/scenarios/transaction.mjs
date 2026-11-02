// ПЛЕЙСХОЛДЕР: сценарий «транзакция» (ТЗ §13 NFR: транзакция ≤2 с, docs/discovery/implementation-backlog.md T1-05).
// Включить, когда появится эндпоинт транзакции: убрать skip, задать тело запроса и Idempotency-Key.
export default {
  name: "transaction",
  skip: "заглушка до эндпоинта транзакции, ТЗ §13",
  requests: [
    {
      method: "POST",
      path: "/transactions/TODO",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  ],
  load: { connections: 20, duration: 30 },
  thresholds: { p95Ms: 2000, maxErrorRate: 0.001 },
};
