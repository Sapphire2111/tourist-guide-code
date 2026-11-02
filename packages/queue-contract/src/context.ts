/**
 * Контекст выполнения задачи. Воркер всегда действует от имени SYSTEM (не от пользователя);
 * regionId — tenant, в рамках которого выполняется задача, null — кросс-tenant/платформенная задача.
 * Реальное ограничение доступа (RLS по region_id, аудит кросс-tenant задач) — T1-11/T1-13; здесь только каркас.
 */
export interface JobContext {
  readonly actor: "SYSTEM";
  readonly regionId: string | null;
}

/** Контекст SYSTEM для региона (или кросс-tenant при null). */
export function systemContext(regionId: string | null = null): JobContext {
  return { actor: "SYSTEM", regionId };
}

/** Проверка контекста из payload: данные пришли из Redis и могли быть поставлены старым/чужим продюсером. */
export function isJobContext(value: unknown): value is JobContext {
  if (typeof value !== "object" || value === null) return false;
  const { actor, regionId } = value as Record<string, unknown>;
  return actor === "SYSTEM" && (regionId === null || (typeof regionId === "string" && regionId.length > 0));
}
