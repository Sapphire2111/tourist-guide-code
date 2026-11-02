import { APP_ENVS, type AppEnv } from "@tg/server-config";

type Env = Record<string, string | undefined>;

/** Хосты, при которых пустой APP_ENV допустим: локальная машина и сервис postgres из infra/docker-compose.yml. */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "postgres"];

/**
 * Хост строки подключения; не разобралась - undefined (считаем удалённым). pg берёт `host`/`hostaddr` из query
 * вместо хоста URL, поэтому такая строка тоже считается неразобранной.
 */
export function databaseHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("host") || parsed.searchParams.has("hostaddr")) return undefined;
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** Окружения, где seed разрешён. В prod тестовые данные и технические роли (TECH_SUPERUSER) недопустимы. */
export const SEED_ALLOWED_ENVS: readonly AppEnv[] = ["local", "staging"];

export class SeedNotAllowedError extends Error {
  override readonly name = "SeedNotAllowedError";
}

/**
 * Проверка окружения до подключения к БД. Правила совпадают с server-config: пустой APP_ENV = local, но при
 * NODE_ENV=production окружение должно быть указано явно. Неизвестное значение и prod — отказ.
 * `databaseUrl` — строка, под которой seed реально подключится (с учётом fallback DATABASE_MIGRATION_URL →
 * DATABASE_URL): при пустом APP_ENV и нелокальном хосте требуется явный APP_ENV (local | staging), иначе seed
 * мог бы записать TECH_SUPERUSER в удалённую базу из оболочки, где забыли APP_ENV.
 */
export function assertSeedAllowed(env: Env = process.env, databaseUrl?: string): AppEnv {
  const raw = env.APP_ENV?.trim();
  if (!raw && env.NODE_ENV?.trim() === "production")
    throw new SeedNotAllowedError(
      "seed: при NODE_ENV=production APP_ENV должен быть указан явно (local | staging)",
    );
  if (!raw && databaseUrl !== undefined) {
    const host = databaseHost(databaseUrl);
    if (host === undefined || !LOCAL_HOSTS.includes(host))
      throw new SeedNotAllowedError(
        `seed: база на хосте ${host ?? "(не разобран)"} - не локальная, задайте APP_ENV явно (local | staging)`,
      );
  }
  const appEnv = raw || "local";
  if (!(APP_ENVS as readonly string[]).includes(appEnv))
    throw new SeedNotAllowedError(`seed: неизвестный APP_ENV=${appEnv}`);
  if (!SEED_ALLOWED_ENVS.includes(appEnv as AppEnv))
    throw new SeedNotAllowedError(
      `seed запрещён при APP_ENV=${appEnv} (разрешено: ${SEED_ALLOWED_ENVS.join(", ")})`,
    );
  return appEnv as AppEnv;
}
