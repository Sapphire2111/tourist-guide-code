// Аргументы places:amenities (cli/places-amenities.ts).
export class AmenitiesArgsError extends Error {}

export type AmenitiesArgs = {
  region: string;
  /** Запись в БД (по умолчанию — без записи: сводка и CSV). */
  write: boolean;
  /** Без запросов к модели: сколько мест спросить и оценка стоимости. */
  plan: boolean;
  /** Сколько мест максимум отправить модели в этот запуск; null — все. */
  limit: number | null;
  /** Лимит расходов на весь журнал, $: после порога новые запросы не делаются. */
  maxUsd: number;
  /** Журнал JSONL ответов модели (продолжение прогона); обязателен, кроме --plan. */
  out: string | null;
  /** CSV итога; по умолчанию — рядом с журналом (<имя>.csv). */
  csv: string | null;
  concurrency: number;
  /** Только эти места (id через запятую) — проба. */
  only: Set<string>;
};

export const DEFAULT_MAX_USD = 3;

const int = (name: string, v: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AmenitiesArgsError(`${name}: целое ${min}…${max}`);
  return n;
};

export function parseAmenitiesArgs(argv: readonly string[]): AmenitiesArgs {
  const a: AmenitiesArgs = {
    region: "test-region",
    write: false,
    plan: false,
    limit: null,
    maxUsd: DEFAULT_MAX_USD,
    out: null,
    csv: null,
    concurrency: 4,
    only: new Set(),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined || x.startsWith("--")) throw new AmenitiesArgsError(`${k}: нужно значение`);
      return x;
    };
    switch (k) {
      case "--":
        break;
      case "--region":
        a.region = v();
        break;
      case "--write":
        a.write = true;
        break;
      case "--dry-run":
        a.write = false;
        break;
      case "--plan":
        a.plan = true;
        break;
      case "--limit":
        a.limit = int(k, v(), 0, 100_000);
        break;
      case "--max-usd": {
        const n = Number(v());
        if (!Number.isFinite(n) || n <= 0) throw new AmenitiesArgsError(`${k}: сумма в $ больше 0`);
        a.maxUsd = n;
        break;
      }
      case "--out":
        a.out = v();
        break;
      case "--csv":
        a.csv = v();
        break;
      case "--concurrency":
        a.concurrency = int(k, v(), 1, 16);
        break;
      case "--only":
        for (const id of v().split(",")) if (id.trim()) a.only.add(id.trim().toLowerCase());
        break;
      default:
        throw new AmenitiesArgsError(`Неизвестный аргумент ${k}`);
    }
  }
  if (a.plan && a.write) throw new AmenitiesArgsError("--plan и --write вместе не имеют смысла");
  if (!a.plan && !a.out)
    throw new AmenitiesArgsError(
      "Укажите --out <файл.jsonl>: каждый оплаченный ответ модели сразу дописывается в журнал, повторный запуск его не оплачивает",
    );
  return a;
}
