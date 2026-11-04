// Замеры раскладки — после анимации появления экрана: пока она идёт, два замера подряд дают разный сдвиг.
import type { Page } from "@playwright/test";

/** Дождаться конечных анимаций экрана (бесконечные — пульс маркера, туман — не ждём: они не закончатся). */
export async function animationsDone(page: Page, selector = ".kosiv-content"): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((node) =>
      Promise.all(
        node
          .getAnimations({ subtree: true })
          .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
}
