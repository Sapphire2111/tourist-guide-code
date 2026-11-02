// Запуск инструмента из git-хука без pnpm в PATH.
// Хуки общие для всех worktree (.git/hooks основной копии): если в текущей копии инструмент
// не установлен (ветка без T1-04 или нет node_modules) — предупреждаем и не блокируем коммит.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [tool, ...args] = process.argv.slice(2);
const bin = path.join(process.cwd(), "node_modules", ".bin", tool);
if (!existsSync(bin) && !existsSync(`${bin}.cmd`)) {
  console.warn(`[git-hook] ${tool} не найден в node_modules/.bin этой копии — проверка пропущена.`);
  process.exit(0);
}
const r = spawnSync(`npx --no-install ${tool} ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
  stdio: "inherit",
  shell: true,
});
process.exit(r.status ?? 1);
