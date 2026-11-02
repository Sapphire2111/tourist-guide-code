// Области RBAC и их иерархия (roles-and-data §1.2): PLATFORM ⊃ REGION ⊃ ORGANIZATION ⊃ PLACE ⊃ RESOURCE.
// Назначение на область X даёт права на X и всё, что ниже X. Цепочка области — сама область и все её предки до
// PLATFORM; проверка права — есть ли назначение на одну из областей цепочки.
import { Inject, Injectable, Optional } from "@nestjs/common";
import { SCOPE_TYPES, type ScopeType } from "../../db/index.js";

export type ScopeRef =
  | { readonly type: "PLATFORM" }
  | { readonly type: Exclude<ScopeType, "PLATFORM">; readonly id: string };

export const PLATFORM_SCOPE: ScopeRef = Object.freeze({ type: "PLATFORM" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Область с id (uuid приводится к нижнему регистру — как его отдаёт PostgreSQL); не uuid — ошибка. */
export function scope(type: Exclude<ScopeType, "PLATFORM">, id: string): ScopeRef {
  if (!isUuid(id)) throw new Error(`Область ${type}: id не uuid: ${id}`);
  return Object.freeze({ type, id: id.toLowerCase() });
}

export const regionScope = (regionId: string): ScopeRef => scope("REGION", regionId);

/** Уровень области: 0 — PLATFORM, 4 — RESOURCE. */
export function scopeLevel(type: ScopeType): number {
  return SCOPE_TYPES.indexOf(type);
}

export function scopeId(s: ScopeRef): string | null {
  return s.type === "PLATFORM" ? null : s.id;
}

export function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.type === b.type && scopeId(a) === scopeId(b);
}

/** Цепочка от области до PLATFORM включительно (первый элемент — сама область). */
export type ScopeChain = readonly ScopeRef[];

/** Регион цепочки (REGION в ней) или null для PLATFORM. */
export function chainRegionId(chain: ScopeChain): string | null {
  const region = chain.find((s) => s.type === "REGION");
  return region ? scopeId(region) : null;
}

/**
 * Загрузчик родителя области нижнего уровня (ORGANIZATION → REGION, PLACE → ORGANIZATION, RESOURCE → PLACE).
 * undefined — объекта нет (запрос получит 403, не раскрывая существование). Родителя загрузчик берёт из БД
 * сам (roles-and-data §1.2, шаг 3), не из запроса. Вызывается и вне транзакции запроса (guard), и внутри неё
 * (RoleAssignmentService), а объект может быть в другом регионе — читать функцией БД в режиме SYSTEM, как
 * app_active_role_assignments() (миграция 0005). Реальные загрузчики — с таблицами блока 3.
 */
export type ScopeParentLoader = (id: string) => Promise<ScopeRef | undefined> | ScopeRef | undefined;

export type ScopeParentLoaders = Partial<
  Record<Exclude<ScopeType, "PLATFORM" | "REGION">, ScopeParentLoader>
>;

/** DI-токен загрузчиков родителя (по умолчанию нет ни одного; тесты и блок 3 — свои). */
export const SCOPE_PARENT_LOADERS = Symbol("SCOPE_PARENT_LOADERS");

/** Иерархия областей: PLATFORM и REGION известны без БД, нижние уровни — через загрузчики. */
@Injectable()
export class ScopeHierarchy {
  private readonly loaders: ScopeParentLoaders;

  constructor(@Optional() @Inject(SCOPE_PARENT_LOADERS) loaders?: ScopeParentLoaders) {
    this.loaders = loaders ?? {};
  }

  /** Цепочка области; undefined — объект (или его предок) не найден. Нет загрузчика уровня — ошибка конфигурации. */
  async chain(target: ScopeRef): Promise<ScopeChain | undefined> {
    const chain: ScopeRef[] = [target];
    let current = target;
    while (current.type !== "PLATFORM") {
      const parent = await this.parentOf(current);
      if (!parent) return undefined;
      // Родитель строго выше: защита от циклов и перескока уровня вниз.
      if (scopeLevel(parent.type) >= scopeLevel(current.type))
        throw new Error(`Родитель ${parent.type} не выше области ${current.type}`);
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  private async parentOf(s: ScopeRef): Promise<ScopeRef | undefined> {
    if (s.type === "PLATFORM") return undefined;
    if (s.type === "REGION") return PLATFORM_SCOPE;
    const loader = this.loaders[s.type];
    if (!loader) throw new Error(`Нет загрузчика родителя для области ${s.type} (SCOPE_PARENT_LOADERS)`);
    return loader(s.id);
  }
}
