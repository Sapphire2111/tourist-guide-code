// ESLint-правило границ модулей модульного монолита (ADR 0001):
// контекст <pkg>/src/modules/<B>/ импортируется извне (из другого контекста или из src вне modules)
// только через его публичный интерфейс modules/<B>/index.
import path from "node:path";
import noRawSql from "./no-raw-sql.js";

const INDEX_RE = /^index(\.(js|ts|mjs|mts))?$/;

function specOf(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === "TSLiteralType") return specOf(node.literal);
  return undefined;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      deep: "Импорт во внутренности контекста «{{target}}» запрещён: используйте его публичный интерфейс modules/{{target}}/index.",
    },
  },
  create(context) {
    const file = context.filename.split(path.win32.sep).join("/");
    const m = /^(.*?\/src)\/(.*)$/.exec(file); // первый /src/
    if (!m) return {};
    const modulesDir = `${m[1]}/modules`;
    const ownMatch = /^modules\/([^/]+)\//.exec(m[2]);
    const own = ownMatch ? ownMatch[1] : null;

    function check(source) {
      let spec = specOf(source);
      if (typeof spec !== "string") return;
      spec = spec.split(path.win32.sep).join("/");
      if (!spec.startsWith(".")) return;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!resolved.startsWith(`${modulesDir}/`)) return;
      const rest = resolved
        .slice(modulesDir.length + 1)
        .split("/")
        .filter(Boolean);
      const target = rest[0];
      if (!target || target === own) return;
      if (rest.length === 1 || (rest.length === 2 && INDEX_RE.test(rest[1]))) return;
      context.report({ node: source, messageId: "deep", data: { target } });
    }
    const viaSource = (node) => check(node.source);
    return {
      ImportDeclaration: viaSource,
      ExportNamedDeclaration: viaSource,
      ExportAllDeclaration: viaSource,
      ImportExpression: viaSource,
      TSImportType: (node) => check(node.argument),
    };
  },
};

export default { rules: { "module-boundaries": rule, "no-raw-sql": noRawSql } };
