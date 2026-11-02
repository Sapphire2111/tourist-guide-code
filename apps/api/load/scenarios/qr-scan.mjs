// ПЛЕЙСХОЛДЕР: сценарий «скан QR → карточка места» (ТЗ §13 NFR, docs/discovery/implementation-backlog.md T1-05).
// Включить, когда появится эндпоинт (блок 2): убрать skip, задать requests и реальный профиль нагрузки.
export default {
  name: "qr-scan",
  skip: "заглушка до эндпоинта QR (блок 2), ТЗ §13",
  requests: [{ method: "GET", path: "/qr/TODO" }],
  load: { connections: 50, duration: 30 },
  thresholds: { p95Ms: 600, maxErrorRate: 0.001 },
};
