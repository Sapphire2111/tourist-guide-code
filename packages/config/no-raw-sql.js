// ESLint-правило tg/no-raw-sql (T1-10, ADR-005): запросы к БД из кода модулей — только через query builder
// Kysely, который проходит TenantGuardPlugin (фильтр region_id, ошибка без tenant-контекста). Плагин не
// разбирает сырой SQL, поэтому вне слоя БД (apps/api/src/db — там сырой SQL ревьюится вместе с RLS) запрещены:
//   - импорт драйвера `pg` (запросы мимо Kysely и плагина);
//   - `.withoutPlugins()` (снимает плагин);
//   - `CompiledQuery`, `.executeQuery()`, `.getExecutor()`, `.connection()` (готовый запрос уходит в драйвер
//     мимо transformQuery, то есть без проверки контекста вообще);
//   - `sql` с целым оператором (SELECT … FROM, INSERT INTO, UPDATE … SET в любом виде, DELETE FROM, TRUNCATE,
//     MERGE INTO);
//   - `sql.raw()`, `sql.table()`, `sql.id()`, `sql.ref()` (непроверяемый текст и имена таблиц).
// `import type { CompiledQuery }` (только тип) допустим.
// Фрагменты выражений (`sql\`count(*)\``, `extract(epoch from …)`) допустимы. Исключение — только
// `// eslint-disable-next-line tg/no-raw-sql -- <почему безопасно>` и ревью (запрос всё равно под RLS).

const STATEMENT =
  /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\b[\s\S]*?\bset\b|\bdelete\s+from\b|\btruncate\b|\bmerge\s+into\b|^\s*table\s+/i;

/** @param {import("estree").Node} node */
function isSqlTag(node) {
  return node.type === "Identifier" && node.name === "sql";
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      pg: "Драйвер pg вне слоя БД обходит TenantGuardPlugin: используйте Db (Kysely) из src/db.",
      withoutPlugins:
        "withoutPlugins() снимает TenantGuardPlugin (фильтр region_id): так нельзя вне слоя БД.",
      statement:
        "Сырой SQL-оператор не проходит фильтр region_id TenantGuardPlugin: используйте query builder или вынесите запрос в src/db (с withTenant и ревью).",
      executor:
        "{{name}} выполняет SQL мимо TenantGuardPlugin (без проверки tenant-контекста): используйте query builder.",
      dynamic: "sql.{{name}}() — непроверяемый SQL/имя таблицы вне слоя БД: используйте query builder.",
    },
  },
  create(context) {
    const checkSource = (node) => {
      const v = node.source?.value;
      if (typeof v === "string" && (v === "pg" || v.startsWith("pg/")))
        context.report({ node: node.source, messageId: "pg" });
    };
    const executorMethods = new Set(["executeQuery", "getExecutor", "connection"]);
    const dynamicMethods = new Set(["raw", "table", "id", "ref"]);
    return {
      ImportDeclaration(node) {
        checkSource(node);
        if (node.importKind === "type") return;
        for (const s of node.specifiers)
          if (
            s.type === "ImportSpecifier" &&
            s.importKind !== "type" &&
            s.imported.type === "Identifier" &&
            s.imported.name === "CompiledQuery"
          )
            context.report({ node: s, messageId: "executor", data: { name: "CompiledQuery" } });
      },
      MemberExpression(node) {
        if (!node.computed && node.property.type === "Identifier" && node.property.name === "CompiledQuery")
          context.report({ node, messageId: "executor", data: { name: "CompiledQuery" } });
      },
      ImportExpression: checkSource,
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
        if (callee.property.name === "withoutPlugins") context.report({ node, messageId: "withoutPlugins" });
        else if (executorMethods.has(callee.property.name))
          context.report({ node, messageId: "executor", data: { name: `.${callee.property.name}()` } });
        else if (isSqlTag(callee.object) && dynamicMethods.has(callee.property.name))
          context.report({ node, messageId: "dynamic", data: { name: callee.property.name } });
      },
      TaggedTemplateExpression(node) {
        if (!isSqlTag(node.tag)) return;
        const text = node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" x ");
        if (STATEMENT.test(text)) context.report({ node, messageId: "statement" });
      },
    };
  },
};

export default rule;
