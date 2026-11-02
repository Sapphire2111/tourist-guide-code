// Генерация apps/api/openapi.json без запуска сервера на порту (T1-16).
// Запуск: pnpm --filter @tg/api openapi (собирает dist и выполняет dist/scripts/openapi.js).
// preview: true — Nest строит граф модулей и маршруты, но не создаёт провайдеры (БД и т.п. не нужны).
import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { format } from "prettier";
import { AppModule } from "../app.module.js";
import { buildOpenApiDocument } from "../bootstrap/openapi-document.js";

const out = new URL("../../openapi.json", import.meta.url);
// Строка подключения-заглушка: в режиме preview пул не создаётся.
const app = await NestFactory.create(
  AppModule.forRoot({ DATABASE_URL: "postgres://preview@127.0.0.1:1/db" }),
  {
    preview: true,
    logger: false,
  },
);
const doc = buildOpenApiDocument(app);
await app.close();
await writeFile(out, await format(JSON.stringify(doc), { parser: "json", printWidth: 110, endOfLine: "lf" }));
console.log(`OpenAPI → ${fileURLToPath(out)}`);
