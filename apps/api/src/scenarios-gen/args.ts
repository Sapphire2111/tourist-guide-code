// Аргументы scenarios:generate (cli/scenarios-generate.ts).
import { TARGET_THEMES, THEMES, type ThemeCode } from "./briefs.js";

export class GenArgsError extends Error {}

export type GenArgs = {
  region: string;
  count: number;
  dryRun: boolean;
  /** Без запросов к модели: какие заказы собираются, размер промптов. */
  plan: boolean;
  publish: boolean;
  out: string | null;
  fromFile: string | null;
  concurrency: number;
  retries: number;
  /** Раундов «критика» (второй проход модели как местного гида), 0 — без критика. */
  criticRounds: number;
  themes: Set<ThemeCode>;
  areas: Set<string>;
};

const int = (name: string, v: string | undefined, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new GenArgsError(`${name}: целое ${min}…${max}`);
  return n;
};

export function parseGenArgs(argv: readonly string[]): GenArgs {
  const a: GenArgs = {
    region: "test-region",
    count: 10,
    dryRun: false,
    plan: false,
    publish: false,
    out: null,
    fromFile: null,
    concurrency: 4,
    retries: 1,
    criticRounds: 2,
    themes: new Set(),
    areas: new Set(),
  };
  const themeCodes = new Set<string>([...THEMES, ...TARGET_THEMES].map((t) => t.code));
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined || x.startsWith("--")) throw new GenArgsError(`${k}: нужно значение`);
      return x;
    };
    switch (k) {
      case "--":
        break;
      case "--region":
        a.region = v();
        break;
      case "--count":
        a.count = int(k, v(), 1, 300);
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--plan":
        a.plan = true;
        a.dryRun = true;
        break;
      case "--publish":
        a.publish = true;
        break;
      case "--out":
        a.out = v();
        break;
      case "--from-file":
        a.fromFile = v();
        break;
      case "--concurrency":
        a.concurrency = int(k, v(), 1, 16);
        break;
      case "--retries":
        a.retries = int(k, v(), 0, 3);
        break;
      case "--critic-rounds":
        a.criticRounds = int(k, v(), 0, 3);
        break;
      case "--theme":
        for (const t of v().split(",")) {
          if (!themeCodes.has(t))
            throw new GenArgsError(`--theme: неизвестная тема ${t} (${[...themeCodes].join(", ")})`);
          a.themes.add(t as ThemeCode);
        }
        break;
      case "--area":
        for (const x of v().split(",")) a.areas.add(x);
        break;
      default:
        throw new GenArgsError(`Неизвестный аргумент ${k}`);
    }
  }
  if (a.dryRun && a.publish) throw new GenArgsError("--dry-run и --publish вместе не имеют смысла");
  if (a.dryRun && !a.plan && !a.out) throw new GenArgsError("--dry-run: укажите --out <файл.json>");
  return a;
}
