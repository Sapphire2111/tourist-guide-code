// Второй фактор админа (D-52, ADR-0018). Метод в admin_credentials.mfa_method — каркас: пока ни один метод не
// реализован, список поддержанных пуст — учётка с методом не входит, а финансовый гейт (ADR-0011) закрыт.
import type { AdminMfaMethod } from "../../db/index.js";

/** Методы 2FA, которые api реально проверяет при входе. Пусто до реализации D-52. */
export const SUPPORTED_MFA_METHODS: ReadonlySet<AdminMfaMethod> = new Set<AdminMfaMethod>();

/** Настроен ли у учётки поддержанный второй фактор. */
export function hasSupportedMfa(method: AdminMfaMethod | null | undefined): boolean {
  return method !== null && method !== undefined && SUPPORTED_MFA_METHODS.has(method);
}
