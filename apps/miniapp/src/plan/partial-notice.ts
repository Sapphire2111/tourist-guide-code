// «Додано не все місця»: ассистент добавил в «Мій план» не все пункты (сбой посередине) — экран плана сообщает об
// этом один раз после перехода. Флаг — в sessionStorage (недоступен — без сообщения, план всё равно открывается).

const key = (planId: string) => `tg:plan-partial:${planId}`;

export function markPlanPartial(planId: string): void {
  try {
    sessionStorage.setItem(key(planId), "1");
  } catch {
    // Хранилище недоступно — переход без сообщения.
  }
}

/** Был ли план заполнен частично (флаг снимается при чтении). */
export function takePlanPartial(planId: string): boolean {
  try {
    const set = sessionStorage.getItem(key(planId)) !== null;
    sessionStorage.removeItem(key(planId));
    return set;
  } catch {
    return false;
  }
}
