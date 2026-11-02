import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Порт local по умолчанию: 4301 (3000/5173 заняты на машине разработчика). E2E задаёт свой порт через CLI.
const port = Number(process.env.MINIAPP_PORT ?? 4301);

export default defineConfig({
  // Относительные пути к ассетам: статика открывается из любого подкаталога (PWA-совместимо).
  base: "./",
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
