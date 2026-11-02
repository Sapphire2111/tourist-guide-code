// Бюджет размера бандла первого экрана (T1-27, ТЗ §13: «≤2,5 с первый экран на 4G»).
// Считает gzip-размер JS и CSS, которые грузит dist/index.html (script, modulepreload, stylesheet),
// и падает при превышении порога. Ленивые чанки (import()) в первый экран не входят.
// Запуск после сборки: `pnpm check:bundle`.
//
// Обоснование порога JS miniapp 170 КБ gzip. Расчётный «медленный 4G» (профиль Lighthouse):
// 1,6 Мбит/с ≈ 200 КБ/с, RTT 150 мс. Бюджет 2,5 с:
//   ~0,6 с — DNS + TCP + TLS + HTML (≈4 RTT);
//   ~0,85 с — загрузка 170 КБ JS (+ ~15 КБ telegram-web-app.js и CSS параллельно);
//   ~0,7 с — разбор и выполнение ~500 КБ несжатого JS на среднем Android;
//   ~0,35 с — запас на первый запрос к api и рендер.
// Админка desktop-first (широкий канал) — порог мягче.
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const KB = 1024;
const BUDGETS = {
  miniapp: { js: 170 * KB, css: 20 * KB },
  admin: { js: 250 * KB, css: 30 * KB },
};

const root = path.resolve(import.meta.dirname, "..");
let failed = false;

for (const [app, budget] of Object.entries(BUDGETS)) {
  const dist = path.join(root, "apps", app, "dist");
  const htmlPath = path.join(dist, "index.html");
  if (!existsSync(htmlPath)) {
    console.error(`✗ ${app}: нет ${path.relative(root, htmlPath)} — сначала pnpm build`);
    failed = true;
    continue;
  }
  const html = readFileSync(htmlPath, "utf8");
  // Локальные ассеты первого экрана; внешние (telegram.org) не считаются.
  const refs = new Set(
    [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+\.(?:js|css))"/g)]
      .map((m) => m[1])
      .filter((ref) => !/^(https?:)?\/\//.test(ref)),
  );
  const total = { js: 0, css: 0 };
  for (const ref of refs) {
    const file = path.join(dist, ref.replace(/^\.?\//, ""));
    const size = gzipSync(readFileSync(file), { level: 9 }).length;
    total[ref.endsWith(".css") ? "css" : "js"] += size;
  }
  if (total.js === 0) {
    console.error(`✗ ${app}: в index.html не найден JS первого экрана — проверка не имеет смысла`);
    failed = true;
    continue;
  }
  for (const kind of ["js", "css"]) {
    const ok = total[kind] <= budget[kind];
    failed ||= !ok;
    const fmt = (n) => `${(n / KB).toFixed(1)} КБ`;
    console.log(`${ok ? "✓" : "✗"} ${app} ${kind}: ${fmt(total[kind])} gzip (порог ${fmt(budget[kind])})`);
  }
}

if (failed) {
  console.error("Бюджет бандла превышен (scripts/check-bundle-size.mjs).");
  process.exit(1);
}
