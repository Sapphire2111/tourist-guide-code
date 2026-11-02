// Ролевой режим Mini App: гость (турист) или партнёр.
// TODO(блок 2): роль — из ответа API после проверки initData. Сейчас заглушка: `?role=partner` в URL
// страницы (для разработки и e2e; на сервере ничего не открывает).
export type Role = "guest" | "partner";

export function getStubRole(search: string = window.location.search): Role {
  return new URLSearchParams(search).get("role") === "partner" ? "partner" : "guest";
}
