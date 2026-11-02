// CLI создания админа (ADR-0018, README apps/api, «Вход админа»):
//   pnpm --filter @tg/api admin:create -- --login admin@example.com --role SUPERADMIN
//   pnpm --filter @tg/api admin:create -- --login ra --role REGION_ADMIN --region test-region
// Пароль — ADMIN_PASSWORD, иначе stdin (в терминале — запрос без эха и повтор; из трубы — первая строка).
// В аргументах пароль не принимается. Подключение — DATABASE_URL (роль приложения достаточно), иначе
// DATABASE_MIGRATION_URL. Работает в любом окружении: это и есть способ завести первого SUPERADMIN.
import { createInterface } from "node:readline";
import { createDatabase } from "../db/index.js";
import {
  AdminCreateError,
  assertPassword,
  createAdmin,
  parseAdminCreateArgs,
} from "../modules/admin-auth/index.js";

/** Строка из терминала без эха (символы не печатаются). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(question);
    out._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) return readStdinLine();
  const first = await promptHidden("Пароль: ");
  const second = await promptHidden("Повторите пароль: ");
  if (first !== second) throw new AdminCreateError("admin:create: пароли не совпадают");
  return first;
}

try {
  const args = parseAdminCreateArgs(process.argv.slice(2));
  const password = await readPassword();
  assertPassword(password);
  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) throw new AdminCreateError("admin:create: не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
  const db = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    const created = await createAdmin(db, { ...args, password });
    console.log(
      `Админ создан: login=${args.login} role=${args.role}${args.regionCode ? ` region=${args.regionCode}` : ""} ` +
        `user=${created.userId} assignment=${created.roleAssignmentId}`,
    );
  } finally {
    await db.destroy();
  }
} catch (err) {
  console.error(err instanceof AdminCreateError ? err.message : err);
  process.exitCode = 1;
}
