// Строка подключения для CLI миграций (migrate-cli.ts). Отдельно от apiEnvSchema: CLI запускается
// шагом pre-deploy и не требует остальных переменных api. Сервер берёт DATABASE_URL из проверенного env.

type Env = Record<string, string | undefined>;

/**
 * DATABASE_MIGRATION_URL (отдельная роль-владелец схемы, T1-11), иначе DATABASE_URL — пока роли
 * не разделены. Без обеих — ошибка.
 */
export function migrationDatabaseUrl(env: Env = process.env): string {
  const url = env.DATABASE_MIGRATION_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url)
    throw new Error("Не задан DATABASE_MIGRATION_URL или DATABASE_URL: нужна строка подключения PostgreSQL");
  return url;
}
