// Выполняется один раз в главном процессе Vitest до интеграционных тестов.
import type { TestProject } from "vitest/node";
import { checkDocker } from "./support/docker.js";

declare module "vitest" {
  export interface ProvidedContext {
    dockerAvailable: boolean;
  }
}

/** CI включён при любом непустом CI, кроме "false"/"0". */
function isCI(): boolean {
  const v = (process.env.CI ?? "").trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "0";
}

export default async function setup(project: TestProject): Promise<void> {
  const status = await checkDocker();
  if (!status.available) {
    const msg = `Docker недоступен — интеграционные тесты требуют контейнерный рантайм (Testcontainers). Причина: ${status.reason}`;
    // В CI пропуск недопустим: «зелёный» прогон без реальной проверки хуже красного.
    if (isCI()) throw new Error(`[integration] ${msg}. При CI это ошибка.`);
    console.warn(`\n[integration] ПРОПУСК: ${msg}\n`);
  }
  project.provide("dockerAvailable", status.available);
}
