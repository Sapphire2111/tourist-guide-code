// Нагрузочный каркас (T1-05): поднимает собранный api (dist) на свободном порту и гоняет
// сценарии load/scenarios/*.mjs через autocannon (npm-пакет, без внешних бинарей — запускается и в CI).
// Порог нарушен → код выхода 1. Запуск: `pnpm test:load` (turbo сначала соберёт api).
// Переменные: LOAD_PORT (4320), LOAD_DURATION (сек, по умолчанию из сценария), LOAD_CONNECTIONS.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import autocannon from "autocannon";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const scenariosDir = new URL("./scenarios/", import.meta.url);
const port = Number(process.env.LOAD_PORT ?? 4320); // 3000/5173 заняты на машине разработчика
const baseUrl = `http://127.0.0.1:${port}`;

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function waitForHealth(child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`api завершился с кодом ${child.exitCode} до старта`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // ещё не слушает
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`api не ответил на ${baseUrl}/health за ${timeoutMs} мс`);
}

async function runScenario(s) {
  const latencies = [];
  const instance = autocannon({
    url: baseUrl,
    connections: Number(process.env.LOAD_CONNECTIONS ?? s.load.connections),
    duration: Number(process.env.LOAD_DURATION ?? s.load.duration),
    requests: s.requests,
  });
  instance.on("response", (_client, _status, _bytes, responseTime) => latencies.push(responseTime));
  const result = await instance;
  latencies.sort((a, b) => a - b);
  const total = result.requests.total;
  const failed = result.errors + result.timeouts + result.non2xx;
  const stats = {
    total,
    p95Ms: Number(percentile(latencies, 95).toFixed(1)),
    errorRate: total ? failed / total : 1,
  };
  const problems = [];
  if (total === 0) problems.push("ни одного запроса");
  if (!(stats.p95Ms <= s.thresholds.p95Ms)) problems.push(`p95 ${stats.p95Ms} мс > ${s.thresholds.p95Ms} мс`);
  if (stats.errorRate > s.thresholds.maxErrorRate)
    problems.push(`ошибок ${(stats.errorRate * 100).toFixed(2)}% > ${s.thresholds.maxErrorRate * 100}%`);
  return { stats, problems };
}

const distMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));
if (!existsSync(distMain)) {
  console.error("Нет apps/api/dist/main.js — сначала сборка (`pnpm test:load` из корня делает её сама).");
  process.exit(1);
}

const scenarios = [];
for (const file of readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".mjs"))
  .sort()) {
  scenarios.push((await import(pathToFileURL(fileURLToPath(new URL(file, scenariosDir))).href)).default);
}

/** Порт свободен? Иначе /health ответил бы чужой процесс. */
function portIsFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port: p }, () => srv.close(() => resolve(true)));
  });
}

if (!(await portIsFree(port))) {
  console.error(`Порт ${port} занят — задайте свободный через LOAD_PORT (чужие процессы не трогаем).`);
  process.exit(1);
}

function assertAlive(child) {
  if (child.exitCode !== null)
    throw new Error(`api завершился с кодом ${child.exitCode} — результаты недостоверны`);
}

const child = spawn(process.execPath, [distMain], {
  cwd: apiDir,
  // /health не ходит в БД; DATABASE_URL обязателен для старта — подставляем недоступный адрес.
  // RATE_LIMIT=off: autocannon шлёт всё с одного IP — иначе меряли бы ответы 429 (T1-24).
  env: {
    DATABASE_URL: "postgres://load:load@127.0.0.1:1/load",
    ...process.env,
    PORT: String(port),
    RATE_LIMIT: "off",
  },
  stdio: ["ignore", "ignore", "inherit"], // логи Nest (stdout) не нужны, ошибки видны
});

let failed = false;
try {
  await waitForHealth(child);
  assertAlive(child); // /health ответил именно наш процесс
  for (const s of scenarios) {
    if (s.skip) {
      console.log(`- ${s.name}: ПРОПУСК — ${s.skip}`);
      continue;
    }
    const { stats, problems } = await runScenario(s);
    assertAlive(child);
    const line = `${s.name}: ${stats.total} запросов, p95 ${stats.p95Ms} мс (порог ${s.thresholds.p95Ms}), ошибок ${(stats.errorRate * 100).toFixed(2)}%`;
    if (problems.length) {
      failed = true;
      console.error(`✗ ${line}\n  ${problems.join("; ")}`);
    } else {
      console.log(`✓ ${line}`);
    }
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  child.kill();
}
process.exit(failed ? 1 : 0);
