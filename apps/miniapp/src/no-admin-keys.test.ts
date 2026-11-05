// Строки admin.* не входят в бандл Mini App (scripts/split-i18n.mjs): в исходниках miniapp их быть не должно.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

describe("miniapp без admin.*", () => {
  it("исходники не ссылаются на ключи admin.*", () => {
    const self = path.basename(import.meta.filename);
    const hits = files(import.meta.dirname)
      .filter((f) => path.basename(f) !== self)
      .filter((f) => /["'`]admin\./.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(import.meta.dirname, f));
    expect(hits).toEqual([]);
  });
});
