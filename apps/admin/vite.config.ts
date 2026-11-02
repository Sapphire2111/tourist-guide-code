import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Порт local по умолчанию: 4302 (3000/5173 заняты на машине разработчика). E2E задаёт свой порт через CLI.
const port = Number(process.env.ADMIN_PORT ?? 4302);

// Сборка на Render (RENDER=true) без VITE_API_URL — ошибка: иначе бандл ушёл бы на localhost.
if (process.env.RENDER && !process.env.VITE_API_URL) {
  throw new Error("VITE_API_URL не задан: укажите адрес api для сборки админки");
}

export default defineConfig({
  // Относительные пути к ассетам: статика открывается из любого подкаталога (PWA-совместимо).
  base: "./",
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
