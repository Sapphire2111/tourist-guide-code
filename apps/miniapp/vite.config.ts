import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Порт local по умолчанию: 4301 (3000/5173 заняты на машине разработчика). E2E задаёт свой порт через CLI.
const port = Number(process.env.MINIAPP_PORT ?? 4301);

/** Шрифты первого экрана (кириллица): заголовок заставки и интерфейс — preload, без ожидания разбора CSS. */
const PRELOAD_FONTS = [
  /inter-cyrillic-wght-normal-[\w-]+\.woff2$/,
  /cormorant-garamond-cyrillic-wght-normal-[\w-]+\.woff2$/,
];

function preloadFonts(): Plugin {
  return {
    name: "preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => PRELOAD_FONTS.some((re) => re.test(f)));
        return files.map((f) => ({
          tag: "link",
          attrs: { rel: "preload", href: `./${f}`, as: "font", type: "font/woff2", crossorigin: "" },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

export default defineConfig({
  // Относительные пути к ассетам: статика открывается из любого подкаталога (PWA-совместимо).
  base: "./",
  plugins: [react(), preloadFonts()],
  // Шрифты (≈ 20 КБ каждый) — отдельными файлами, не data: в CSS.
  build: { assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined) },
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
});
