import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Порт local по умолчанию: 4302 (3000/5173 заняты на машине разработчика). E2E задаёт свой порт через CLI.
const port = Number(process.env.ADMIN_PORT ?? 4302);

export default defineConfig({
  // Относительные пути к ассетам: статика открывается из любого подкаталога (PWA-совместимо).
  base: "./",
  plugins: [react()],
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
