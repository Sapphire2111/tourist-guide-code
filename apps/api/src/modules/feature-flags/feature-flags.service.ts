import { Inject, Injectable } from "@nestjs/common";
import type { Db, FeatureFlagGateMark, FeatureFlagRow } from "../../db/index.js";
import { hasSupportedMfa } from "../admin-auth/index.js";
import { AuditService, type AuditActor, type AuditPii } from "../audit/index.js";
import { isGrantActive, RbacService } from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import {
  evaluateFlags,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,
  FINANCE_GATE_DECISIONS,
  FINANCE_GATE_ROLE,
  isFeatureFlagKey,
  isFinanceGateDecision,
  rawValue,
  type AppEnv,
  type FeatureFlagKey,
  type FlagOverrides,
} from "./catalog.js";
import { FeatureFlagsRepository } from "./feature-flags.repository.js";

/** DI-токен окружения (APP_ENV), для которого берутся значения флагов по умолчанию. */
export const FEATURE_FLAGS_APP_ENV = Symbol("FEATURE_FLAGS_APP_ENV");

/** Коды действий в аудите (audit_logs.action). */
export const FEATURE_FLAG_AUDIT_ACTIONS = {
  set: "feature_flag.set",
  gateMark: "feature_flag.gate_mark",
} as const;
export const FEATURE_FLAG_ENTITY = "feature_flag";
export const FEATURE_FLAG_GATE_ENTITY = "feature_flag_gate_mark";

export type FeatureFlagErrorReason =
  | "unknown_flag"
  | "region_not_found"
  | "finance_gate_role"
  | "finance_gate_open"
  | "finance_gate_mfa"
  | "unknown_decision"
  | "already_marked";

/** Отказ изменения флага/отметки; HTTP-код выбирает контроллер. */
export class FeatureFlagError extends Error {
  override readonly name = "FeatureFlagError";

  constructor(
    readonly reason: FeatureFlagErrorReason,
    /** finance_gate_open: решения без отметки. */
    readonly missing: readonly string[] = [],
  ) {
    super(`FeatureFlag: ${reason}`);
  }
}

type AuditMeta = {
  actor: AuditActor;
  /** Назначение, по которому действует актор-пользователь (req.authorization.grant.id). */
  actorAssignmentId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  /** ПДн запроса (IP, user agent, сессия) — в audit_log_pii по сроку D-73. */
  pii?: AuditPii;
};

export type SetFlagInput = AuditMeta & {
  key: string;
  /** null — переопределение на всё окружение. */
  regionId: string | null;
  /** null — удалить переопределение (вернуть значение по умолчанию окружения). */
  enabled: boolean | null;
};

export type GateMarkInput = AuditMeta & { decision: string; documentRef: string };

/** Флаг в админском списке: значение по умолчанию окружения, переопределения и эффективное значение окружения. */
export type FeatureFlagState = {
  key: FeatureFlagKey;
  description: string;
  requires: readonly FeatureFlagKey[];
  financeGate: boolean;
  default: boolean;
  /** Переопределение на всё окружение или null. */
  override: boolean | null;
  /** Переопределения по регионам. */
  regionOverrides: { regionId: string; enabled: boolean }[];
  /** Эффективное значение на уровне окружения (без регионов). */
  effective: boolean;
};

/**
 * Фича-флаги (T1-22, ADR-0011): эффективные значения (каталог + переопределения окружения и региона) и их
 * изменение админом платформы с записью в аудит в той же транзакции. Финансовый гейт (D-81): включить флаг с
 * financeGate (finance.live) в prod может только пользователь с назначением SUPERADMIN на PLATFORM и только когда
 * отмечено закрытие всех ⚖-решений FINANCE_GATE_DECISIONS, и только со вторым фактором (D-52, пока не реализован —
 * гейт закрыт). Выключить можно всегда (аварийный выключатель).
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    @Inject(FEATURE_FLAGS_APP_ENV) readonly appEnv: AppEnv,
    @Inject(FeatureFlagsRepository) private readonly repo: FeatureFlagsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
  ) {}

  /** Эффективные значения всех флагов для региона (null — уровень окружения). */
  async effective(regionId: string | null): Promise<Record<FeatureFlagKey, boolean>> {
    const rows = await this.repo.overridesFor(regionId);
    return evaluateFlags(this.appEnv, toOverrides(rows, regionId));
  }

  async isEnabled(key: FeatureFlagKey, regionId: string | null): Promise<boolean> {
    return (await this.effective(regionId))[key];
  }

  /** Состояние всех флагов каталога для админки. */
  async list(): Promise<FeatureFlagState[]> {
    const rows = await this.repo.listAll();
    const effective = evaluateFlags(this.appEnv, toOverrides(rows, null));
    return FEATURE_FLAG_KEYS.map((key) => {
      const def = FEATURE_FLAGS[key];
      const own = rows.filter((r) => r.key === key);
      return {
        key,
        description: def.description,
        requires: def.requires,
        financeGate: def.financeGate,
        default: def.defaults[this.appEnv],
        override: own.find((r) => r.target_region_id === null)?.enabled ?? null,
        regionOverrides: own
          .filter((r) => r.target_region_id !== null)
          .map((r) => ({ regionId: r.target_region_id!, enabled: r.enabled })),
        effective: effective[key],
      };
    });
  }

  gateMarks(): Promise<FeatureFlagGateMark[]> {
    return this.repo.gateMarks();
  }

  /** Установить или сбросить переопределение. trx — транзакция запроса в контексте PLATFORM/SYSTEM. */
  async set(trx: Db, input: SetFlagInput): Promise<FeatureFlagRow | undefined> {
    requireTransaction(trx);
    if (!isFeatureFlagKey(input.key)) throw new FeatureFlagError("unknown_flag");
    const key = input.key;
    const regionId = input.regionId?.toLowerCase() ?? null;
    if (regionId !== null && !(await this.regions.findById(regionId)))
      throw new FeatureFlagError("region_not_found");
    const repo = new FeatureFlagsRepository(trx);
    await repo.lock(key, regionId);
    const before = await repo.find(key, regionId);
    let actorAssignmentId = input.actorAssignmentId ?? null;
    if (
      FEATURE_FLAGS[key].financeGate &&
      this.appEnv === "prod" &&
      (await this.turnsOn(repo, key, regionId, input))
    )
      actorAssignmentId = await this.checkFinanceGate(input.actor);
    const row =
      input.enabled === null
        ? await repo.remove(key, regionId)
        : await repo.upsert(key, regionId, input.enabled, actorId(input.actor));
    // Сброс несуществующего переопределения ничего не меняет — и в аудит не пишется.
    if (input.enabled === null && !before) return undefined;
    await this.audit.record(trx, {
      actor: input.actor,
      roleAssignmentId: actorAssignmentId,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      pii: input.pii,
      action: FEATURE_FLAG_AUDIT_ACTIONS.set,
      entityType: FEATURE_FLAG_ENTITY,
      entityId: key,
      oldValues: { enabled: before?.enabled ?? null },
      newValues: { enabled: input.enabled, appEnv: this.appEnv },
      regionId,
    });
    return input.enabled === null ? undefined : row;
  }

  /** Отметка о закрытии ⚖-решения финансового гейта (D-81); повторная — already_marked. */
  async markGate(trx: Db, input: GateMarkInput): Promise<FeatureFlagGateMark> {
    requireTransaction(trx);
    if (!isFinanceGateDecision(input.decision)) throw new FeatureFlagError("unknown_decision");
    const mark = await new FeatureFlagsRepository(trx).addGateMark(
      input.decision,
      input.documentRef.trim(),
      actorId(input.actor),
    );
    if (!mark) throw new FeatureFlagError("already_marked");
    await this.audit.record(trx, {
      actor: input.actor,
      roleAssignmentId: input.actorAssignmentId ?? null,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      pii: input.pii,
      action: FEATURE_FLAG_AUDIT_ACTIONS.gateMark,
      entityType: FEATURE_FLAG_GATE_ENTITY,
      entityId: mark.decision,
      newValues: { decision: mark.decision, documentRef: mark.document_ref },
      regionId: null,
    });
    return mark;
  }

  /**
   * Станет ли собственное значение флага true после изменения: включение — да; сброс переопределения (null) — если
   * после удаления строки действует true (переопределение окружения при сбросе регионального, значение по умолчанию).
   */
  private async turnsOn(
    repo: FeatureFlagsRepository,
    key: FeatureFlagKey,
    regionId: string | null,
    input: SetFlagInput,
  ): Promise<boolean> {
    if (input.enabled !== null) return input.enabled;
    const rest = (await repo.overridesFor(regionId)).filter(
      (r) => !(r.key === key && (r.target_region_id?.toLowerCase() ?? null) === regionId),
    );
    return rawValue(key, this.appEnv, toOverrides(rest, regionId));
  }

  /**
   * Финансовый гейт в prod: актор — пользователь с действующим назначением FINANCE_GATE_ROLE на PLATFORM, и все
   * решения FINANCE_GATE_DECISIONS отмечены, и у актора настроен поддержанный второй фактор (D-52; пока методов нет —
   * гейт закрыт). Возвращает назначение SUPERADMIN — оно и пишется в аудит.
   */
  private async checkFinanceGate(actor: AuditActor): Promise<string> {
    if (actor.type !== "user") throw new FeatureFlagError("finance_gate_role");
    const now = new Date();
    const grant = (await this.rbac.grantsOf(actor.userId)).find(
      (g) => g.role === FINANCE_GATE_ROLE && g.scopeType === "PLATFORM" && isGrantActive(g, now),
    );
    if (!grant) throw new FeatureFlagError("finance_gate_role");
    const marked = new Set((await this.repo.gateMarks()).map((m) => m.decision));
    const missing = FINANCE_GATE_DECISIONS.filter((d) => !marked.has(d));
    if (missing.length) throw new FeatureFlagError("finance_gate_open", missing);
    // Второй фактор у SUPERADMIN (roles-and-data §1.4 «P 2FA»): пока D-52 не реализован, поддержанных методов нет —
    // гейт в prod закрыт для всех, даже с полными отметками (иначе SUPERADMIN один, по паролю, открыл бы финансы).
    if (!hasSupportedMfa(await this.repo.mfaMethodOf(actor.userId)))
      throw new FeatureFlagError("finance_gate_mfa");
    return grant.id;
  }
}

function toOverrides(rows: readonly FeatureFlagRow[], regionId: string | null): FlagOverrides {
  const global: Partial<Record<FeatureFlagKey, boolean>> = {};
  const region: Partial<Record<FeatureFlagKey, boolean>> = {};
  const target = regionId?.toLowerCase() ?? null;
  for (const r of rows) {
    // Ключ не из каталога (флаг удалён из кода) — игнорируется.
    if (!isFeatureFlagKey(r.key)) continue;
    if (r.target_region_id === null) global[r.key] = r.enabled;
    else if (target !== null && r.target_region_id.toLowerCase() === target) region[r.key] = r.enabled;
  }
  return { global, region };
}

function actorId(actor: AuditActor): string | null {
  return actor.type === "user" ? actor.userId : null;
}

function requireTransaction(trx: Db): void {
  if (!trx.isTransaction)
    throw new Error("FeatureFlagsService: передайте транзакцию запроса (withTenant), а не корневой db");
}
