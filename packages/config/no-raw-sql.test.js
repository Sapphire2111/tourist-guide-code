// Тесты правила tg/no-raw-sql: node --test (ESLint RuleTester).
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import plugin from "./module-boundaries.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = plugin.rules["no-raw-sql"];
const e = (messageId) => [{ messageId }];

tester.run("no-raw-sql", rule, {
  valid: [
    `import { sql } from "kysely"; const n = sql<number>\`count(*)\`;`,
    "const t = sql`extract(epoch from ${col})`;",
    "const g = sql`ST_DWithin(${a}::geography, ${b}::geography, ${m})`;",
    `db.selectFrom("audit_logs").selectAll().execute();`,
    "const s = other`select * from audit_logs`;",
    `import { Pool } from "pg-boss";`,
    `import type { Db } from "../../db/index.js";`,
    `import { sql, type Kysely } from "kysely";`,
    "const s = sql`coalesce(${a}, ${b})`;",
    "const query = q.execute();",
    `import type { CompiledQuery } from "kysely";`,
    `import { sql, type CompiledQuery } from "kysely";`,
    "const t = sql`count(*) filter (where table_name = 'x')`;",
  ],
  invalid: [
    { code: `import pg from "pg";`, errors: e("pg") },
    { code: `import { Client } from "pg";`, errors: e("pg") },
    { code: `const pg = await import("pg");`, errors: e("pg") },
    { code: "db.withoutPlugins().selectFrom('audit_logs');", errors: e("withoutPlugins") },
    { code: "await sql`SELECT * FROM audit_logs`.execute(db);", errors: e("statement") },
    {
      code: "await sql<{ n: number }>`select count(*) as n\n from ${t}`.execute(db);",
      errors: e("statement"),
    },
    { code: "await sql`INSERT INTO audit_logs (a) VALUES (${a})`.execute(db);", errors: e("statement") },
    { code: "await sql`update analytics_events set x = 1`.execute(db);", errors: e("statement") },
    { code: "await sql`UPDATE audit_logs AS a SET x = 1`.execute(db);", errors: e("statement") },
    { code: "await sql`UPDATE ONLY audit_logs SET x = 1`.execute(db);", errors: e("statement") },
    {
      code: "await sql`update ${sql.id(t)}\n set x = 1`.execute(db);",
      errors: [{ messageId: "statement" }, { messageId: "dynamic" }],
    },
    { code: `import { CompiledQuery } from "kysely";`, errors: e("executor") },
    { code: `import { sql, CompiledQuery as CQ } from "kysely";`, errors: e("executor") },
    { code: "const q = kysely.CompiledQuery.raw('select 1');", errors: e("executor") },
    { code: "await db.executeQuery(q);", errors: e("executor") },
    { code: "const ex = db.getExecutor();", errors: e("executor") },
    { code: "await db.connection().execute(async (c) => c);", errors: e("executor") },
    { code: "await sql`DELETE FROM audit_logs`.execute(db);", errors: e("statement") },
    { code: "await sql`truncate audit_logs`.execute(db);", errors: e("statement") },
    { code: "const q = sql.raw(text);", errors: [{ messageId: "dynamic" }] },
    { code: 'const q = sql.id("audit_logs");', errors: [{ messageId: "dynamic" }] },
    { code: 'const q = sql.ref("audit_logs");', errors: [{ messageId: "dynamic" }] },
    { code: 'db.selectFrom(sql.id("audit_logs").as("a"));', errors: [{ messageId: "dynamic" }] },
    { code: "await sql`TABLE audit_logs`.execute(db);", errors: e("statement") },
    { code: "await sql`  table ${t}`.execute(db);", errors: e("statement") },
    { code: `import { type Kysely, CompiledQuery } from "kysely";`, errors: e("executor") },
    {
      code: "const q = sql`select 1 from ${sql.table(name)}`;",
      errors: [{ messageId: "statement" }, { messageId: "dynamic" }],
    },
  ],
});
