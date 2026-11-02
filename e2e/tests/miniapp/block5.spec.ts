// Блок 5: «QR отеля → Про заклад → заявка → (персонал) done» и «Мій план: сценарий → замена пункта».
// api не поднят — support/block5-mock.ts (переходы статусов и 409 — как на сервере).
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.describe("QR отеля demoHotel01", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("Про заклад → заявка → Мої заявки → персонал: accepted → in_progress → done; a11y", async ({
    page,
  }) => {
    const state = apiMockState.get(page)!;
    state.staff = true;
    state.acceptingNow = false;
    await page.goto("/");
    await page.getByTestId("home-sections").getByRole("link", { name: "Про заклад" }).click();
    await expect(page.getByTestId("venue-name")).toHaveText("Тестовий готель");
    await expect(page.getByRole("heading", { name: "Правила проживання" })).toBeVisible();
    await expect(page.getByText("Пароль: welcome123")).toBeVisible();
    await expect(page.getByTestId("intake-closed")).toContainText("08:00");
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("button", { name: "Замовити: Прибирання номера" }).click();
    await page.getByLabel("Номер кімнати").fill("204");
    await page.getByLabel("Коментар (необов'язково)").fill("Після 10:00");
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Надіслати заявку" }).click();
    await expect(page.getByTestId("request-sent")).toContainText("Її буде оброблено з");
    expect(state.serviceRequests).toHaveLength(1);
    expect(state.serviceRequests[0]).toMatchObject({ roomLabel: "204", comment: "Після 10:00" });

    // Повторная заявка той же услуги — 409 (активная уже есть).
    await page.getByRole("button", { name: "Замовити: Прибирання номера" }).click();
    await page.getByLabel("Номер кімнати").fill("204");
    await page.getByRole("button", { name: "Надіслати заявку" }).click();
    await expect(page.getByTestId("request-error")).toHaveText(
      "Така заявка вже є — дочекайтеся її виконання.",
    );
    await page.getByRole("button", { name: "Скасувати", exact: true }).click();

    await page.getByTestId("my-requests-link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Мої заявки" })).toBeVisible();
    await expect(page.getByTestId("request-status")).toHaveText("Нова");
    await expect(page.getByTestId("request-room")).toHaveText("Номер 204 (вказано гостем)");
    await expectNoSeriousA11yViolations(page);

    // Режим персонала (D-50): ссылка на главной при роли ORG_STAFF.
    await page.goto("/#/");
    await page.getByTestId("staff-link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Заявки гостей" })).toBeVisible();
    const item = page.getByTestId("staff-request");
    await expect(item).toContainText("Гість: Олена");
    await expectNoSeriousA11yViolations(page);
    await item.getByRole("button", { name: "Прийняти" }).click();
    await expect(page.getByTestId("staff-message")).toHaveText("Статус змінено: Прийнята");
    await item.getByRole("button", { name: "Почати виконання" }).click();
    await expect(item.getByTestId("request-status")).toHaveText("Виконується");
    await item.getByRole("button", { name: "Виконано" }).click();
    await expect(item.getByTestId("request-status")).toHaveText("Виконана");
    expect(state.serviceRequests[0]!.status).toBe("done");

    await page.getByTestId("staff-filter").selectOption("new");
    await expect(page.getByTestId("staff-empty")).toBeVisible();

    await page.goto("/#/requests");
    await expect(page.getByTestId("request-status")).toHaveText("Виконана");
  });

  test("персонал: 409 при устаревшем статусе — сообщение и обновлённый список", async ({ page }) => {
    const state = apiMockState.get(page)!;
    state.staff = true;
    state.serviceRequests.push({
      id: "00000000-0000-4000-8000-000000000699",
      serviceCode: "towels",
      roomLabel: "101",
      status: "new",
      statusReason: null,
      comment: null,
      outsideHours: false,
      idempotencyKey: "k",
    });
    await page.goto("/#/staff");
    const item = page.getByTestId("staff-request");
    await expect(item.getByRole("button", { name: "Прийняти" })).toBeVisible();
    state.serviceRequests[0]!.status = "done"; // другой сотрудник уже закрыл
    await item.getByRole("button", { name: "Прийняти" }).click();
    await expect(page.getByTestId("staff-message")).toHaveText(
      "Статус уже змінено іншим співробітником. Список оновлено.",
    );
    await expect(item.getByTestId("request-status")).toHaveText("Виконана");
  });

  test("без роли персонала ссылки нет, экран закрыт", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeVisible();
    await expect(page.getByTestId("staff-link")).toHaveCount(0);
    await page.goto("/#/staff");
    await expect(page.getByTestId("staff-forbidden")).toBeVisible();
  });

  test("роль персонала назначили при открытом Mini App — ссылка появляется при возврате на главную", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeVisible();
    await expect(page.getByTestId("staff-link")).toHaveCount(0);
    apiMockState.get(page)!.staff = true;
    await page.getByTestId("home-sections").getByRole("link", { name: "Про заклад" }).click();
    await expect(page.getByTestId("venue-name")).toBeVisible();
    await page.goBack();
    await page.getByTestId("staff-link").click();
    await expect(page.getByTestId("staff-forbidden")).toHaveCount(0);
  });

  test("флаг module.host_requests выключен: нет «Мій план», заявок и режима персонала", async ({ page }) => {
    apiMockState.get(page)!.staff = true;
    await page.route("**/feature-flags*", (route) =>
      route.fulfill({ json: { items: [{ key: "module.host_requests", enabled: false }] } }),
    );
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Основна навігація" });
    await expect(nav.getByRole("link", { name: "Обране" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Мій план" })).toHaveCount(0);
    await expect(page.getByTestId("staff-link")).toHaveCount(0);
    await page.getByTestId("home-sections").getByRole("link", { name: "Про заклад" }).click();
    await expect(page.getByRole("heading", { name: "Правила проживання" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Замовити/ })).toHaveCount(0);
    await expect(page.getByTestId("my-requests-link")).toHaveCount(0);
    for (const path of ["/#/plan", "/#/requests", "/#/staff"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeVisible();
    }
  });

  test("Мій план: сценарий → зберегти → замена пункта → картка місця; a11y", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Основна навігація" });
    await nav.getByRole("link", { name: "Мій план" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Мій план" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Мій план" })).toHaveAttribute("aria-current", "page");
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("link", { name: "Один день у місті" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Один день у місті" })).toBeVisible();
    await expect(page.getByTestId("plan-item")).toHaveCount(2);
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Зберегти як план" }).click();

    await expect(page.getByRole("button", { name: "Замінити: Кав'ярня «Смерека»" })).toBeVisible();
    await page.getByRole("button", { name: "Замінити: Кав'ярня «Смерека»" }).click();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Замінити на: Піцерія «Реклама»" }).click();
    await expect(page.getByTestId("plan-status")).toHaveText("Пункт замінено: Піцерія «Реклама»");
    await expect(page.getByTestId("plan-item").first().getByRole("checkbox")).toHaveAccessibleName(
      "Піцерія «Реклама»",
    );

    await page.getByRole("checkbox", { name: "Тестовий готель" }).uncheck();
    await expect(page.getByTestId("plan-item")).toHaveCount(1);

    await page.getByRole("link", { name: "До списку" }).click();
    await expect(page.getByTestId("saved-plan")).toHaveCount(1);
    await page.getByTestId("saved-plan").getByRole("link").click();
    await page.getByTestId("plan-item").first().getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Піцерія «Реклама»" })).toBeVisible();
  });

  test("Мій план: параметри (діти, без авто, 2 дні) → варіанти → галочки → план; a11y", async ({ page }) => {
    const state = apiMockState.get(page)!;
    await page.goto("/#/plan");
    await page.getByRole("link", { name: "Скласти свій план" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Свій план" })).toBeVisible();
    await page.getByRole("button", { name: "Більше: Діти" }).click();
    await page.getByRole("button", { name: "Більше: Днів" }).click();
    await page.getByRole("button", { name: "Без авто" }).click();
    await expect(page.getByText(/не пропонуємо бари й нічні клуби/)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Підібрати варіанти" }).click();

    await expect(page.getByTestId("trip-line")).toHaveText("Дорослих: 2 · Дітей: 1 · Без авто · Днів: 2");
    await expect(page.getByText("Відстані — по прямій від: Тестовий готель")).toBeVisible();
    expect(state.plans[0]!.trip).toMatchObject({ adults: 2, children: 1, withCar: false, days: 2 });
    await expect(page.getByTestId("plan-day")).toHaveCount(2);
    const day1 = page.getByTestId("plan-day").first();
    // С детьми бара нет; далеко без авто — «Потрібен транспорт»; что это — подпись вида.
    await expect(day1.getByText("Бар «Нічний Прут»")).toHaveCount(0);
    const mountain = day1.getByTestId("plan-option").filter({ hasText: "Гора Маковиця" });
    await expect(mountain).toContainText("Потрібен транспорт");
    await expect(mountain.getByTestId("option-kind")).toHaveText("Пам'ятка природи");
    await expect(
      day1.getByTestId("plan-option").filter({ hasText: "Водоспад Пробій" }).getByTestId("option-kind"),
    ).toHaveText("Водоспад");
    await expectNoSeriousA11yViolations(page);

    await day1.getByRole("checkbox", { name: "Водоспад Пробій" }).check();
    await expect(page.getByTestId("plan-status")).toHaveText("Додано в план: Водоспад Пробій");
    await day1.getByRole("checkbox", { name: "Колиба «Ватра»" }).check();
    await expect(page.getByTestId("plan-status")).toHaveText("Додано в план: Колиба «Ватра»");
    const rain = day1.getByTestId("plan-slot-rain");
    await expect(rain.getByRole("heading", { name: "Якщо дощ — план Б" })).toBeVisible();
    await rain.getByRole("checkbox", { name: "Музей писанки" }).check();
    await expect(page.getByTestId("plan-status")).toHaveText("Додано в план: Музей писанки");

    await expect(day1.getByTestId("plan-item")).toHaveCount(3);
    await expect(day1.getByRole("checkbox", { name: "Водоспад Пробій" })).toBeChecked();
    // Остальные варианты утра свёрнуты.
    await expect(day1.getByTestId("plan-slot-morning").getByText("Ще варіанти: 2")).toBeVisible();
    await expect(
      day1.getByTestId("plan-slot-morning").getByRole("checkbox", { name: "Кав'ярня «Смерека»" }),
    ).toBeHidden();
    await expectNoSeriousA11yViolations(page);

    // Снять галочку — убрать из плана.
    await day1.getByRole("checkbox", { name: "Колиба «Ватра»" }).uncheck();
    await expect(day1.getByTestId("plan-item")).toHaveCount(2);

    // Параметры: 1 день.
    await page.getByRole("button", { name: "Змінити параметри" }).click();
    await page.getByRole("button", { name: "Менше: Днів" }).click();
    await page.getByRole("button", { name: "Зберегти параметри" }).click();
    await expect(page.getByTestId("plan-status")).toHaveText("Параметри збережено — варіанти оновлено.");
    await expect(page.getByTestId("plan-day")).toHaveCount(1);
  });
});

test.describe("тёмная тема Telegram", () => {
  test.use({ telegram: { startParam: "demoHotel01", colorScheme: "dark" } });

  test("Про заклад и Мій план: a11y в тёмной теме", async ({ page }) => {
    await page.goto("/#/about");
    await expect(page.getByRole("heading", { name: "Правила проживання" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.goto("/#/plan");
    await expect(page.getByTestId("scenario-item")).toHaveCount(1);
    await expectNoSeriousA11yViolations(page);
  });
});
