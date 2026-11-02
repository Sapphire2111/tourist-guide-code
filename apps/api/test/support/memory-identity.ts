// Хранилища в памяти для unit-тестов входа через Telegram и профиля (без БД): та же семантика, что у SQL
// репозиториев (уникальность telegram_user_id → ошибка 23505, действующие согласия, открытые запросы).
// SQL, триггеры и RLS — test/integration/telegram-auth.test.ts.
import { randomUUID } from "node:crypto";
import {
  Global,
  Module,
  type DynamicModule,
  type INestApplication,
  type LoggerService,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { analyticsEventSchema, type AnalyticsEvent } from "@tg/shared";
import type {
  Consent,
  ConsentChannel,
  ConsentKind,
  MessagingConsent,
  MessagingConsentSource,
  MessagingPurpose,
  NewRiskFlag,
  NewSession,
  NewTelegramAccount,
  NewUser,
  PrivacyRequest,
  PrivacyRequestKind,
  RiskFlag,
  Session,
  SessionRevokeReason,
  TelegramAccount,
  TelegramAccountUpdate,
  User,
  UserUpdate,
} from "../../src/db/index.js";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule } from "../../src/common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../src/db/index.js";
import { AnalyticsService } from "../../src/modules/analytics/index.js";
import { AuditModule, AuditService, type AuditEntry } from "../../src/modules/audit/index.js";
import {
  AuthModule,
  RiskFlagsRepository,
  SessionsRepository,
  type ActiveSession,
} from "../../src/modules/auth/index.js";
import {
  ConsentsRepository,
  MessagingConsentsRepository,
  PrivacyRequestsRepository,
  ProfileModule,
} from "../../src/modules/profile/index.js";
import {
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
} from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { TelegramAccountsRepository, UsersRepository } from "../../src/modules/users/index.js";
import { recordingDb } from "./recording-db.js";

const now = () => new Date();

export class MemoryIdentity {
  readonly users = new Map<string, User>();
  readonly accounts = new Map<string, TelegramAccount>();
  readonly sessions = new Map<string, Session>();
  readonly riskFlags: RiskFlag[] = [];
  readonly consents: Consent[] = [];
  readonly messaging: MessagingConsent[] = [];
  readonly privacy: PrivacyRequest[] = [];
  readonly audit: AuditEntry[] = [];
  readonly events: AnalyticsEvent[] = [];
  /** Вызовы UsersRepository.lockForUpdate (порядок блокировок). */
  readonly locks: string[] = [];

  reset(): void {
    for (const c of [this.users, this.accounts, this.sessions]) c.clear();
    for (const a of [
      this.riskFlags,
      this.consents,
      this.messaging,
      this.privacy,
      this.audit,
      this.events,
      this.locks,
    ])
      a.length = 0;
  }

  readonly usersRepo = {
    create: (u: NewUser = {}): Promise<User> => {
      const row: User = {
        id: randomUUID(),
        status: u.status ?? "active",
        language: u.language ?? "uk",
        display_name: u.display_name ?? null,
        analytics_id: u.analytics_id ?? randomUUID(),
        created_at: now(),
        updated_at: now(),
      };
      this.users.set(row.id, row);
      return Promise.resolve(row);
    },
    findById: (id: string) => Promise.resolve(this.users.get(id)),
    lockForUpdate: (id: string) => {
      this.locks.push(id);
      return Promise.resolve(this.users.has(id));
    },
    update: (id: string, patch: UserUpdate) => {
      const u = this.users.get(id);
      if (u) Object.assign(u, patch, { updated_at: now() });
      return Promise.resolve(u);
    },
  };

  readonly accountsRepo = {
    findByTelegramUserId: (tgId: number) =>
      Promise.resolve([...this.accounts.values()].find((a) => a.telegram_user_id === String(tgId))),
    findByUserId: (userId: string) =>
      Promise.resolve([...this.accounts.values()].find((a) => a.user_id === userId)),
    create: (a: NewTelegramAccount): Promise<TelegramAccount> => {
      const dup = [...this.accounts.values()].some(
        (x) => x.telegram_user_id === String(a.telegram_user_id) || x.user_id === a.user_id,
      );
      if (dup) return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
      const row: TelegramAccount = {
        id: randomUUID(),
        user_id: a.user_id,
        telegram_user_id: String(a.telegram_user_id),
        username: a.username ?? null,
        first_name: a.first_name ?? null,
        last_name: a.last_name ?? null,
        language_code: a.language_code ?? null,
        photo_url: a.photo_url ?? null,
        is_premium: a.is_premium ?? false,
        allows_write_to_pm: a.allows_write_to_pm ?? false,
        last_auth_date: new Date(a.last_auth_date),
        created_at: now(),
        updated_at: now(),
      };
      this.accounts.set(row.id, row);
      return Promise.resolve(row);
    },
    update: (id: string, patch: TelegramAccountUpdate) => {
      const a = this.accounts.get(id);
      if (a) Object.assign(a, patch, { updated_at: now() });
      return Promise.resolve(a);
    },
  };

  readonly sessionsRepo = {
    create: (s: NewSession): Promise<Session> => {
      const row: Session = {
        id: randomUUID(),
        user_id: s.user_id,
        token_hash: s.token_hash,
        channel: s.channel,
        active_region_id: s.active_region_id ?? null,
        expires_at: new Date(s.expires_at),
        revoked_at: null,
        revoke_reason: null,
        created_at: now(),
        updated_at: now(),
      };
      this.sessions.set(row.id, row);
      return Promise.resolve(row);
    },
    findById: (id: string) => Promise.resolve(this.sessions.get(id)),
    findActiveByTokenHash: (hash: Buffer): Promise<ActiveSession | undefined> => {
      const s = [...this.sessions.values()].find((r) => r.token_hash.equals(hash));
      const ok = s && !s.revoked_at && s.expires_at > now() && this.users.get(s.user_id)?.status === "active";
      return Promise.resolve(
        ok
          ? { id: s.id, userId: s.user_id, channel: s.channel, activeRegionId: s.active_region_id }
          : undefined,
      );
    },
    revoke: (id: string, reason: SessionRevokeReason) => {
      const s = this.sessions.get(id);
      if (!s || s.revoked_at) return Promise.resolve(undefined);
      Object.assign(s, { revoked_at: now(), revoke_reason: reason });
      return Promise.resolve(s);
    },
    setActiveRegion: (id: string, regionId: string | null) => {
      const s = this.sessions.get(id);
      if (s) s.active_region_id = regionId;
      return Promise.resolve(s);
    },
  };

  readonly riskFlagsRepo = {
    create: (f: NewRiskFlag): Promise<RiskFlag> => {
      const row: RiskFlag = {
        id: randomUUID(),
        region_id: f.region_id ?? null,
        user_id: f.user_id ?? null,
        kind: f.kind,
        severity: f.severity ?? "low",
        status: f.status ?? "open",
        details: f.details ?? {},
        request_id: f.request_id ?? null,
        resolved_by: null,
        resolved_at: null,
        created_at: now(),
        updated_at: now(),
      };
      this.riskFlags.push(row);
      return Promise.resolve(row);
    },
  };

  readonly consentsRepo = {
    listActive: (userId: string) =>
      Promise.resolve(this.consents.filter((c) => c.user_id === userId && !c.withdrawn_at).reverse()),
    findLatest: (userId: string, kind: ConsentKind, version: string) =>
      Promise.resolve(
        this.consents
          .filter((c) => c.user_id === userId && c.kind === kind && c.document_version === version)
          .at(-1),
      ),
    grant: (i: { userId: string; kind: ConsentKind; version: string; channel: ConsentChannel }) => {
      const row: Consent = {
        id: randomUUID(),
        user_id: i.userId,
        kind: i.kind,
        document_version: i.version,
        channel: i.channel,
        granted_at: now(),
        withdrawn_at: null,
        created_at: now(),
      };
      this.consents.push(row);
      return Promise.resolve(row);
    },
    withdraw: (id: string) => {
      const c = this.consents.find((x) => x.id === id && !x.withdrawn_at);
      if (c) c.withdrawn_at = now();
      return Promise.resolve(c);
    },
  };

  readonly messagingRepo = {
    list: (userId: string) => Promise.resolve(this.messaging.filter((m) => m.user_id === userId)),
    find: (userId: string, purpose: MessagingPurpose) =>
      Promise.resolve(this.messaging.find((m) => m.user_id === userId && m.purpose === purpose)),
    set: (i: {
      userId: string;
      purpose: MessagingPurpose;
      granted: boolean;
      source: MessagingConsentSource;
    }) => {
      let row = this.messaging.find((m) => m.user_id === i.userId && m.purpose === i.purpose);
      if (!row) {
        row = {
          id: randomUUID(),
          user_id: i.userId,
          channel: "telegram_bot",
          purpose: i.purpose,
          granted: i.granted,
          source: i.source,
          granted_at: null,
          withdrawn_at: null,
          created_at: now(),
          updated_at: now(),
        };
        this.messaging.push(row);
      }
      Object.assign(row, {
        granted: i.granted,
        source: i.source,
        granted_at: i.granted ? now() : row.granted_at,
        withdrawn_at: i.granted ? null : now(),
      });
      return Promise.resolve(row);
    },
  };

  readonly privacyRepo = {
    listOpen: (userId: string) =>
      Promise.resolve(this.privacy.filter((p) => p.user_id === userId && p.status === "received")),
    findOpen: (userId: string, kind: PrivacyRequestKind) =>
      Promise.resolve(
        this.privacy.find((p) => p.user_id === userId && p.kind === kind && p.status === "received"),
      ),
    create: (userId: string, kind: PrivacyRequestKind) => {
      const row: PrivacyRequest = {
        id: randomUUID(),
        user_id: userId,
        kind,
        status: "received",
        handled_by: null,
        handled_at: null,
        rejection_reason: null,
        created_at: now(),
        updated_at: now(),
      };
      this.privacy.push(row);
      return Promise.resolve(row);
    },
  };

  readonly auditService = {
    record: (_trx: unknown, entry: AuditEntry) => {
      this.audit.push(entry);
      return Promise.resolve({});
    },
  };

  /** Глобальный модуль с AnalyticsService, записывающим события в память. */
  analyticsModule(): DynamicModule {
    const events = this.events;
    @Global()
    @Module({})
    class MemoryAnalyticsModule {}
    return {
      module: MemoryAnalyticsModule,
      providers: [
        {
          provide: AnalyticsService,
          useValue: {
            // Как настоящий emit: событие не по схеме каталога — ошибка.
            emit: (e: AnalyticsEvent) => {
              events.push(analyticsEventSchema.parse(e) as AnalyticsEvent);
              return Promise.resolve();
            },
          },
        },
      ],
      exports: [AnalyticsService],
    };
  }
}

/** Приложение с AuthModule (вход через Telegram) и ProfileModule поверх хранилищ в памяти. */
export async function identityApp(
  mem: MemoryIdentity,
  opts: { botToken?: string; logger?: LoggerService | false } = {},
): Promise<INestApplication> {
  const { db } = recordingDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      RbacModule,
      AuthModule.forRoot({ appEnv: "local", telegramBotToken: opts.botToken }),
      AuditModule,
      ProfileModule,
      mem.analyticsModule(),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(SessionsRepository)
    .useValue(mem.sessionsRepo)
    .overrideProvider(UsersRepository)
    .useValue(mem.usersRepo)
    .overrideProvider(TelegramAccountsRepository)
    .useValue(mem.accountsRepo)
    .overrideProvider(RiskFlagsRepository)
    .useValue(mem.riskFlagsRepo)
    .overrideProvider(ConsentsRepository)
    .useValue(mem.consentsRepo)
    .overrideProvider(MessagingConsentsRepository)
    .useValue(mem.messagingRepo)
    .overrideProvider(PrivacyRequestsRepository)
    .useValue(mem.privacyRepo)
    .overrideProvider(RegionsRepository)
    .useValue({ findById: () => Promise.resolve(undefined) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve([]) })
    .overrideProvider(AuditService)
    .useValue(mem.auditService)
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: opts.logger ?? false }), {
    appEnv: "local",
  });
  await app.init();
  return app;
}
