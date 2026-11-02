// Первый рубеж изоляции регионов (ADR-005, T1-10): плагин Kysely на AST запроса.
// - Запрос к tenant/tenant-optional таблице (tenancy.ts) без tenant-контекста — TenantContextError.
// - Контекст региона: в SELECT/UPDATE/DELETE к каждой такой таблице во FROM/JOIN/USING/UPDATE добавляется
//   `<таблица|алиас>.region_id = :region` (в JOIN — в ON, во FROM — в WHERE; существующее условие берётся в
//   скобки), включая подзапросы и CTE. INSERT: `region_id` подставляется из контекста, другой регион или NULL —
//   ошибка. Изменение `region_id` в UPDATE — ошибка (колонка неизменяема).
// - Контекст SYSTEM/PLATFORM: запрос не меняется (кросс-tenant).
// - Сырой SQL (`sql\`…\``) не разбирается: если он упоминает tenant-таблицу, требуется только наличие
//   контекста, фильтр даёт RLS (второй рубеж). Поэтому сырые запросы в модулях запрещены линтом (tg/no-raw-sql).
// - ON CONFLICT DO UPDATE в tenant-таблицу: обновляется только строка своего региона, region_id менять нельзя.
// - Уже стоящее условие считается фильтром, только если это конъюнкт `t.region_id = :регион` (оператор `=`).
// Ограничения (ошибка, а не тихий пропуск): сырой SQL-источник с tenant-таблицей во FROM/JOIN
// (`sql\`audit_logs\`.as("a")`), RIGHT/FULL JOIN tenant-таблицы, INSERT … SELECT и MERGE в
// tenant-таблицу в контексте региона.
import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  IdentifierNode,
  OnNode,
  OperationNodeTransformer,
  OperatorNode,
  ParensNode,
  PrimitiveValueListNode,
  RawNode,
  ReferenceNode,
  TableNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhereNode,
  type ColumnUpdateNode,
  type DeleteQueryNode,
  type InsertQueryNode,
  type JoinNode,
  type KyselyPlugin,
  type MergeQueryNode,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
  type UpdateQueryNode,
} from "kysely";
import { REGION_COLUMN, TABLE_TENANCY, tenantTableNames, type TenancyMap } from "./tenancy.js";
import { currentTenant, TenantContextError, type TenantContext } from "./tenant-context.js";

export type TenantGuardOptions = {
  /** Классификация таблиц; по умолчанию TABLE_TENANCY (тесты добавляют свои tenant-таблицы). */
  tables?: TenancyMap;
  /**
   * Контекст, если запрос выполняется вне withTenant(). Только для тестов и служебных скриптов под ролью-
   * владельцем: переменные RLS он не выставляет. Сервер приложения его не задаёт.
   */
  defaultTenant?: TenantContext;
};

/** Целевые таблицы запроса: имя tenant-таблицы и как на неё ссылаться (алиас или имя). */
type Target = { table: string; ref: string };

export class TenantGuardPlugin implements KyselyPlugin {
  private readonly tenantTables: ReadonlySet<string>;
  private readonly defaultTenant: TenantContext | undefined;

  constructor({ tables = TABLE_TENANCY, defaultTenant }: TenantGuardOptions = {}) {
    this.tenantTables = tenantTableNames(tables);
    this.defaultTenant = defaultTenant;
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    const used = new TableCollector(this.tenantTables).collect(node);
    if (used.size === 0) return node;
    const tenant = currentTenant() ?? this.defaultTenant;
    if (!tenant)
      throw new TenantContextError(
        `Запрос к tenant-таблице (${[...used].join(", ")}) без tenant-контекста: выполните его в withTenant()`,
      );
    if (tenant.kind !== "region") return node;
    return new RegionFilter(this.tenantTables, tenant.regionId).transformNode(node, queryId);
  }

  transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(result);
  }
}

function tableName(node: TableNode): string {
  return node.table.identifier.name;
}

/**
 * Tenant-таблицы, которые сырой узел называет сам: в тексте фрагментов и в параметрах-именах —
 * `sql.id("audit_logs")` (IdentifierNode), `sql.ref("audit_logs")` (ReferenceNode), `sql.table(…)` (TableNode),
 * вложенный `sql\`${…}\``. Параметры-подзапросы (query builder) не считаются: их фильтрует обход дерева.
 */
function rawTenantMentions(raw: RawNode, tenantTables: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const add = (name: string | undefined) => {
    const n = name?.toLowerCase();
    if (n && tenantTables.has(n)) found.add(n);
  };
  const text = raw.sqlFragments.join(" ").toLowerCase();
  for (const t of tenantTables) if (new RegExp(`\\b${t}\\b`).test(text)) found.add(t);
  const visit = (node: OperationNode): void => {
    if (IdentifierNode.is(node)) add(node.name);
    else if (TableNode.is(node)) add(tableName(node));
    else if (ReferenceNode.is(node)) {
      if (ColumnNode.is(node.column)) add(node.column.column.name);
      if (node.table) add(tableName(node.table));
    } else if (AliasNode.is(node)) visit(node.node);
    else if (RawNode.is(node)) for (const t of rawTenantMentions(node, tenantTables)) found.add(t);
  };
  raw.parameters.forEach(visit);
  return found;
}

/** Собирает упомянутые tenant-таблицы: TableNode где угодно и имена в сыром SQL (rawTenantMentions). */
class TableCollector extends OperationNodeTransformer {
  private readonly found = new Set<string>();

  constructor(private readonly tenantTables: ReadonlySet<string>) {
    super();
  }

  collect(node: OperationNode): ReadonlySet<string> {
    this.transformNode(node);
    return this.found;
  }

  protected override transformTable(node: TableNode, queryId?: QueryId): TableNode {
    const name = tableName(node);
    if (this.tenantTables.has(name)) this.found.add(name);
    return super.transformTable(node, queryId);
  }

  protected override transformRaw(node: RawNode, queryId?: QueryId): RawNode {
    for (const t of rawTenantMentions(node, this.tenantTables)) this.found.add(t);
    return super.transformRaw(node, queryId);
  }
}

/** Добавляет фильтр региона в запросы к tenant-таблицам (контекст региона). */
class RegionFilter extends OperationNodeTransformer {
  constructor(
    private readonly tenantTables: ReadonlySet<string>,
    private readonly regionId: string,
  ) {
    super();
  }

  /** Tenant-таблица в позиции FROM/JOIN: `t`, `t as a`, `schema.t`; подзапросы и прочее — undefined. */
  private target(node: OperationNode): Target | undefined {
    if (TableNode.is(node)) {
      const table = tableName(node);
      return this.tenantTables.has(table) ? { table, ref: table } : undefined;
    }
    if (AliasNode.is(node) && TableNode.is(node.node) && IdentifierNode.is(node.alias)) {
      const table = tableName(node.node);
      return this.tenantTables.has(table) ? { table, ref: node.alias.name } : undefined;
    }
    return undefined;
  }

  private condition({ ref }: Target): OperationNode {
    return BinaryOperationNode.create(
      ReferenceNode.create(ColumnNode.create(REGION_COLUMN), TableNode.create(ref)),
      OperatorNode.create("="),
      ValueNode.create(this.regionId),
    );
  }

  /**
   * Условие этого региона на ref уже есть (подзапрос из `db.selectFrom` плагин обработал при сборке): только
   * конъюнкт вида `ref.region_id = :регион` с оператором `=`; `<>`, `>`, `is distinct from`, OR — не считаются.
   */
  private hasCondition(filter: OperationNode | undefined, ref: string): boolean {
    const found = (node: OperationNode): boolean => {
      if (AndNode.is(node)) return found(node.left) || found(node.right);
      if (ParensNode.is(node)) return found(node.node);
      return (
        BinaryOperationNode.is(node) &&
        OperatorNode.is(node.operator) &&
        node.operator.operator === "=" &&
        ReferenceNode.is(node.leftOperand) &&
        ColumnNode.is(node.leftOperand.column) &&
        node.leftOperand.column.column.name === REGION_COLUMN &&
        node.leftOperand.table?.table.identifier.name === ref &&
        ValueNode.is(node.rightOperand) &&
        node.rightOperand.value === this.regionId
      );
    };
    return filter ? found(filter) : false;
  }

  /**
   * Сырой источник во FROM/JOIN/USING (`sql\`audit_logs\`.as("a")`, `sql.id("audit_logs").as("a")`,
   * `sql.ref(…)`, `sql.table(…)`), называющий tenant-таблицу, фильтр добавить не может — ошибка (иначе запрос ушёл бы без фильтра региона).
   */
  private rejectRawSource(item: OperationNode | undefined): void {
    const raw = item && (AliasNode.is(item) ? item.node : item);
    if (!raw || !RawNode.is(raw)) return;
    const [hit] = rawTenantMentions(raw, this.tenantTables);
    if (hit)
      throw new TenantContextError(
        `Сырой SQL-источник с tenant-таблицей ${hit} во FROM/JOIN: фильтр региона не добавить, используйте query builder`,
      );
  }

  /** Условия для tenant-таблиц из списка FROM/USING, которых ещё нет в where. */
  private conditions(
    items: ReadonlyArray<OperationNode | undefined>,
    where: WhereNode | undefined,
  ): OperationNode[] {
    items.forEach((item) => this.rejectRawSource(item));
    return items.flatMap((item) => {
      const t = item && this.target(item);
      return t && !this.hasCondition(where?.where, t.ref) ? [this.condition(t)] : [];
    });
  }

  /** Условия в ON для JOIN tenant-таблиц; CROSS JOIN — условие в WHERE. */
  private filterJoins(joins: ReadonlyArray<JoinNode> | undefined): {
    joins: ReadonlyArray<JoinNode> | undefined;
    where: OperationNode[];
  } {
    const where: OperationNode[] = [];
    const out = joins?.map((join) => {
      this.rejectRawSource(join.table);
      const t = this.target(join.table);
      if (!t) return join;
      if (join.joinType === "RightJoin" || join.joinType === "FullJoin")
        throw new TenantContextError(
          `${join.joinType} tenant-таблицы ${t.table} не поддерживается фильтром региона: перепишите запрос`,
        );
      if (this.hasCondition(join.on?.on, t.ref)) return join;
      if (!join.on) {
        where.push(this.condition(t));
        return join;
      }
      return Object.freeze({
        ...join,
        on: OnNode.create(and(ParensNode.create(join.on.on), this.condition(t))),
      });
    });
    return { joins: out, where };
  }

  protected override transformSelectQuery(node: SelectQueryNode, queryId?: QueryId): SelectQueryNode {
    const n = super.transformSelectQuery(node, queryId);
    const { joins, where } = this.filterJoins(n.joins);
    return withWhere({ ...n, joins }, [...this.conditions(n.from?.froms ?? [], n.where), ...where]);
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    const n = super.transformUpdateQuery(node, queryId);
    const target = n.table && this.target(n.table);
    if (target) rejectRegionUpdate(n.updates, target.table);
    const { joins, where } = this.filterJoins(n.joins);
    return withWhere({ ...n, joins }, [
      ...this.conditions([n.table, ...(n.from?.froms ?? [])], n.where),
      ...where,
    ]);
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    const n = super.transformDeleteQuery(node, queryId);
    const { joins, where } = this.filterJoins(n.joins);
    return withWhere({ ...n, joins }, [
      ...this.conditions([...n.from.froms, ...(n.using?.tables ?? [])], n.where),
      ...where,
    ]);
  }

  protected override transformInsertQuery(node: InsertQueryNode, queryId?: QueryId): InsertQueryNode {
    const n = super.transformInsertQuery(node, queryId);
    if (!n.into || !this.tenantTables.has(tableName(n.into))) return n;
    return this.filterOnConflict(this.fillRegion(n, tableName(n.into)), tableName(n.into));
  }

  /**
   * ON CONFLICT DO UPDATE: конфликтующая строка может принадлежать другому региону (уникальность по id или
   * естественному ключу общая) — обновление ограничивается своим регионом (`WHERE t.region_id = :регион`,
   * иначе DO NOTHING по факту), менять region_id нельзя.
   */
  private filterOnConflict(n: InsertQueryNode, table: string): InsertQueryNode {
    const oc = n.onConflict;
    if (!oc?.updates) return n;
    rejectRegionUpdate(oc.updates, table);
    const cond = this.condition({ table, ref: table });
    const updateWhere = oc.updateWhere
      ? WhereNode.create(and(ParensNode.create(oc.updateWhere.where), cond))
      : WhereNode.create(cond);
    return Object.freeze({ ...n, onConflict: Object.freeze({ ...oc, updateWhere }) });
  }

  /** region_id строк INSERT: подставить из контекста или проверить, что совпадает с ним. */
  private fillRegion(n: InsertQueryNode, table: string): InsertQueryNode {
    if (n.defaultValues)
      return Object.freeze({
        ...n,
        defaultValues: undefined,
        columns: [ColumnNode.create(REGION_COLUMN)],
        values: ValuesNode.create([PrimitiveValueListNode.create([this.regionId])]),
      });
    if (!n.values || !ValuesNode.is(n.values))
      throw new TenantContextError(
        `INSERT в ${table} без VALUES (INSERT … SELECT) в контексте региона не поддерживается`,
      );
    const columns = n.columns ?? [];
    const idx = columns.findIndex((c) => c.column.name === REGION_COLUMN);
    if (idx < 0)
      return Object.freeze({
        ...n,
        columns: [...columns, ColumnNode.create(REGION_COLUMN)],
        values: ValuesNode.create(
          n.values.values.map((row) =>
            PrimitiveValueListNode.is(row)
              ? PrimitiveValueListNode.create([...row.values, this.regionId])
              : ValueListNode.create([...row.values, ValueNode.create(this.regionId)]),
          ),
        ),
      });
    for (const row of n.values.values) {
      const cell = PrimitiveValueListNode.is(row) ? undefined : row.values[idx];
      const v = PrimitiveValueListNode.is(row)
        ? row.values[idx]
        : cell && ValueNode.is(cell)
          ? cell.value
          : undefined;
      if (typeof v !== "string" || v.toLowerCase() !== this.regionId)
        throw new TenantContextError(`INSERT в ${table}: ${REGION_COLUMN} не совпадает с регионом контекста`);
    }
    return n;
  }

  protected override transformMergeQuery(): MergeQueryNode {
    throw new TenantContextError("MERGE с tenant-таблицами в контексте региона не поддерживается");
  }
}

/** SET region_id = … в UPDATE или ON CONFLICT DO UPDATE — ошибка: колонка неизменяема (ADR-006). */
function rejectRegionUpdate(updates: ReadonlyArray<ColumnUpdateNode> | undefined, table: string): void {
  for (const u of updates ?? []) {
    const col = ColumnNode.is(u.column)
      ? u.column.column.name
      : ReferenceNode.is(u.column) && ColumnNode.is(u.column.column)
        ? u.column.column.column.name
        : undefined;
    if (col === REGION_COLUMN)
      throw new TenantContextError(`${REGION_COLUMN} в ${table} неизменяем (ADR-006)`);
  }
}

function and(left: OperationNode, right: OperationNode): OperationNode {
  return AndNode.create(left, right);
}

/** `WHERE (существующее) AND c1 AND c2 …`; без условий — узел без изменений. */
function withWhere<T extends { where?: WhereNode }>(node: T, conditions: OperationNode[]): T {
  if (conditions.length === 0) return node;
  const added = conditions.reduce(and);
  const where = node.where
    ? WhereNode.create(and(ParensNode.create(node.where.where), added))
    : WhereNode.create(added);
  return Object.freeze({ ...node, where });
}
