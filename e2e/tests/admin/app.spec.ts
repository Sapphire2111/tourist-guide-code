import { expect, test } from "@playwright/test";

test("админка открывается, меню переключает разделы", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Регіони" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Розділи" });
  for (const name of ["Аудит", "Користувачі", "Регіони"]) {
    await nav.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  }
});
