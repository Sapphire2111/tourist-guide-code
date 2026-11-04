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

const fallbackKey = (planId: string) => `tg:plan-fallback:${planId}`;

/** Claude не составил план (флаг planner.ai) — экран плана один раз скажет «оберіть варіанти вручну». */
export function markPlanFallback(planId: string): void {
  try {
    sessionStorage.setItem(fallbackKey(planId), "1");
  } catch {
    // Хранилище недоступно — переход без сообщения.
  }
}

export function takePlanFallback(planId: string): boolean {
  try {
    const set = sessionStorage.getItem(fallbackKey(planId)) !== null;
    sessionStorage.removeItem(fallbackKey(planId));
    return set;
  } catch {
    return false;
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
