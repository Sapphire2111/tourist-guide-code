// Тесты правила tg/module-boundaries: node --test (ESLint RuleTester).
import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import path from "node:path";
import plugin from "./module-boundaries.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const rule = plugin.rules["module-boundaries"];
const SYS = "/repo/apps/api/src/modules/system/system.module.ts";
const APP = "/repo/apps/api/src/app.module.ts";
const BS = path.win32.sep;
const WIN = ["C:", "repo", "apps", "api", "src", "modules", "system", "system.module.ts"].join(BS);
const DBL = BS + BS; // в литерале исходника — экранированный обратный слэш
const err = [{ messageId: "deep" }];

tester.run("module-boundaries", rule, {
  valid: [
    { filename: SYS, code: `import { H } from "../health/index.js";` },
    { filename: SYS, code: `import { H } from "../health";` },
    { filename: SYS, code: `import { H } from "../health/";` },
    { filename: SYS, code: `import { H } from "../health/index";` },
    { filename: SYS, code: `import { X } from "./internal/x.js";` },
    { filename: SYS, code: `import { X } from "@nestjs/common";` },
    { filename: APP, code: `import { H } from "./modules/health/index.js";` },
    { filename: APP, code: `import { M } from "./main.js";` },
    { filename: WIN, code: `import { H } from "..${DBL}health${DBL}index.js";` },
    { filename: SYS, code: "const m = import(`../health/index.js`);" },
    // путь проекта с /modules/ выше src не путает правило
    {
      filename: "/modules/x/apps/api/src/modules/system/a.ts",
      code: `import { H } from "../health/index.js";`,
    },
  ],
  invalid: [
    { filename: SYS, code: `import { H } from "../health/health.module.js";`, errors: err },
    { filename: SYS, code: `export * from "../health/internal/a.js";`, errors: err },
    { filename: SYS, code: `export { H } from "../health/health.module.js";`, errors: err },
    { filename: APP, code: `import { C } from "./modules/health/health.controller.js";`, errors: err },
    { filename: SYS, code: `const m = import("../health/health.module.js");`, errors: err },
    { filename: SYS, code: "const m = import(`../health/health.module.js`);", errors: err },
    { filename: SYS, code: `type T = import("../health/health.module.js").HealthModule;`, errors: err },
    { filename: SYS, code: `import { H } from "..${DBL}health${DBL}health.module.js";`, errors: err },
    { filename: WIN, code: `import { H } from "..${DBL}health${DBL}health.module.js";`, errors: err },
    {
      filename: "/modules/x/apps/api/src/modules/system/a.ts",
      code: `import { H } from "../health/a.js";`,
      errors: err,
    },
  ],
});
