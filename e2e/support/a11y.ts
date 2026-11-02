// a11y-аудит axe-core: блокируют только нарушения уровня serious/critical (WCAG 2.1 A/AA).
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const BLOCKING = new Set(["serious", "critical"]);

export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = violations.filter((v) => v.impact && BLOCKING.has(v.impact));
  const report = blocking.map((v) => `${v.impact}: ${v.id} — ${v.help} (${v.nodes.length} эл.)`).join("\n");
  expect(blocking, report).toEqual([]);
}
