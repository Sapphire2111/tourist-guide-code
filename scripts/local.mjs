// Local-окружение через Docker Compose: `pnpm local:up` | `pnpm local:down` [доп. аргументы compose].
// Корневой .env (если есть) передаётся в compose для подстановки ${TELEGRAM_BOT_TOKEN} и т. п.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [action, ...rest] = process.argv.slice(2);
const commands = { up: ["up", "-d", "--build"], down: ["down"] };
if (!commands[action]) {
  console.error("Использование: node scripts/local.mjs up|down [аргументы docker compose]");
  process.exit(2);
}
const args = ["compose", "-f", "infra/docker-compose.yml"];
if (existsSync(new URL("../.env", import.meta.url))) args.push("--env-file", ".env");
args.push(...commands[action], ...rest);

const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(
    `Не удалось запустить docker: ${result.error.message}. Установлен ли Docker Desktop / Engine?`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
