// Мок api для E2E админки (api в E2E не поднят): вход по логину/паролю, сессия, справочники, места
// (публикация с проверкой publish-check), график, QR (создание, печать), экстренные контакты, журнал.
// Состояние — на страницу, меняется запросами, как на сервере. Логин/пароль — ADMIN_LOGIN / ADMIN_PASSWORD.
import type { Page, Route } from "@playwright/test";

export const ADMIN_LOGIN = "admin@example.com";
export const ADMIN_PASSWORD = "correct-horse-battery";

const TOKEN = "e2e-admin-token";
const REGION_ID = "00000000-0000-4000-8000-0000000000a1";
const NOW = "2026-11-02T10:00:00Z";

type Obj = Record<string, unknown> & { id: string };

export type AdminMockState = {
  places: Obj[];
  categories: Obj[];
  tags: Obj[];
  localities: Obj[];
  qrPoints: Obj[];
  contacts: Obj[];
  /** Сколько раз вызван POST /admin/places/{id}/publish. */
  publishCalls: number;
  /** Пользователь — SUPERADMIN (назначение PLATFORM): регион выбирается в сессии. */
  platform: boolean;
  activeRegionId: string | null;
  /** Фото мест: placeId → привязки. */
  placeMedia: Record<string, Obj[]>;
  /** Файлы media: id → { status, опросы до ready }. */
  media: Record<string, Obj & { polls: number }>;
  /** Тела PUT /auth/session/region. */
  regionChoices: unknown[];
  /** Роль без прав на модуль готелю и персонал (модератор каталога): 403 на эти разделы. */
  noHostAccess: boolean;
  /** Модули готелю: placeId → тело (нет записи — не настраивался). */
  hostModules: Record<string, Obj>;
  /** Тела PUT /admin/places/{id}/host-module. */
  hostPuts: unknown[];
  /** Персонал мест: placeId → назначения. */
  staff: Record<string, Obj[]>;
  /** Сценарии региона (с пунктами). */
  scenarios: Obj[];
  /** Тела PUT/POST /admin/scenarios. */
  scenarioWrites: unknown[];
  /** Заявки модерации партнёров (блок 6). */
  moderationCases: Obj[];
  /** Тела решений: { id, decision, body }. */
  moderationDecisions: { id: string; decision: string; body: unknown }[];
  /** Роль без права place.moderate: 403 на модерацию. */
  noModeration: boolean;
  /** Возможные дубли в карточке заявки. */
  moderationDuplicates: Obj[];
};

export const adminMockState = new WeakMap<Page, AdminMockState>();

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const SESSION = {
  id: "00000000-0000-4000-8000-0000000000e1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  channel: "admin_web",
  expiresAt: "2099-01-01T00:00:00Z",
  activeRegionId: REGION_ID,
  grants: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      role: "REGION_ADMIN",
      scopeType: "REGION",
      scopeId: REGION_ID,
      regionId: REGION_ID,
      validUntil: null,
    },
  ],
};

const REGION_B = {
  id: "00000000-0000-4000-8000-0000000000a2",
  code: "test-region-b",
  name: { uk: "Регіон Б", en: "Region B" },
  status: "active",
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
  updatedAt: "2026-11-02T10:00:00Z",
};

// Превью фото: маленький PNG 1×1 (data URL — без сети).
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const REGION = {
  id: REGION_ID,
  code: "test-region",
  name: { uk: "Тестовий регіон", en: "Test region" },
  status: "active",
  timezone: "Europe/Kyiv",
  defaultLanguage: "uk",
  updatedAt: NOW,
};

/** Проблемы публикации — как publishProblems api (фото в моке нет). */
function publishProblems(place: Obj): string[] {
  const problems: string[] = [];
  if (!(place.description as { uk?: string } | null)?.uk) problems.push("description_missing");
  if (!(place.address as { uk?: string } | null)?.uk) problems.push("address_missing");
  if (!place.location) problems.push("location_missing");
  return problems;
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/>' +
  '<path d="M4 4h7v7H4zM18 4h7v7h-7zM4 18h7v7H4z" fill="#000"/></svg>';

export async function installAdminApiMock(page: Page): Promise<AdminMockState> {
  const categoryId = uuid();
  const state: AdminMockState = {
    places: [
      {
        id: uuid(),
        status: "published",
        categoryId,
        localityId: null,
        name: { uk: "Водоспад Пробій" },
        description: { uk: "Опис" },
        address: { uk: "Яремче" },
        location: { lat: 48.45, lon: 24.55 },
        phone: null,
        website: null,
        telegram: null,
        recommended: true,
        hostCapable: false,
        verifiedAt: null,
        tagIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: uuid(),
        status: "published",
        categoryId,
        localityId: null,
        name: { uk: "Готель Карпати" },
        description: { uk: "Опис" },
        address: { uk: "Яремче" },
        location: { lat: 48.46, lon: 24.56 },
        phone: null,
        website: null,
        telegram: null,
        recommended: false,
        hostCapable: true,
        verifiedAt: null,
        tagIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    categories: [
      {
        id: categoryId,
        parentId: null,
        code: "relax",
        name: { uk: "Релакс" },
        icon: null,
        homeSection: "relax",
        sortOrder: 0,
        active: true,
      },
    ],
    tags: [
      {
        id: uuid(),
        code: "family",
        name: { uk: "Для сім'ї" },
        group: "audience",
        sortOrder: 0,
        active: true,
      },
    ],
    localities: [
      {
        id: uuid(),
        code: "yaremche",
        kind: "settlement",
        name: { uk: "Яремче" },
        location: null,
        sortOrder: 0,
        active: true,
      },
    ],
    qrPoints: [],
    contacts: [
      {
        id: uuid(),
        kind: "general",
        name: { uk: "Єдиний номер екстрених служб" },
        phone: "112",
        description: null,
        sortOrder: 0,
        regionId: REGION_ID,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    publishCalls: 0,
    platform: false,
    activeRegionId: REGION_ID,
    placeMedia: {},
    media: {},
    regionChoices: [],
    noHostAccess: false,
    hostModules: {},
    hostPuts: [],
    staff: {},
    scenarios: [],
    scenarioWrites: [],
    moderationCases: [
      {
        id: "00000000-0000-4000-8000-000000000901",
        regionId: REGION_ID,
        placeId: "00000000-0000-4000-8000-000000000902",
        placeName: { uk: "Кафе Говерла" },
        placeStatus: "pending_moderation",
        organizationId: "00000000-0000-4000-8000-000000000903",
        organizationName: "ФОП Іваненко",
        templateCode: "cafe",
        templateName: { uk: "Кафе" },
        decidedByName: null,
        ownOrganization: false,
        status: "open",
        decision: null,
        comment: null,
        verificationMethod: null,
        submittedBy: "00000000-0000-4000-8000-000000000904",
        submittedByName: "Олена",
        submittedAt: NOW,
        decidedBy: null,
        decidedAt: null,
      },
    ],
    moderationDecisions: [],
    noModeration: false,
    moderationDuplicates: [],
  };
  adminMockState.set(page, state);

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    status === 204
      ? route.fulfill({ status, headers: cors })
      : route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, messageKey: string, details?: unknown) =>
    json(
      route,
      { error: { code, messageKey, ...(details ? { details } : {}), correlationId: "e2e" } },
      status,
    );
  const list = (items: unknown[]) => ({ items, nextCursor: null });

  const session = () =>
    state.platform
      ? {
          ...SESSION,
          activeRegionId: state.activeRegionId,
          grants: [
            {
              ...SESSION.grants[0],
              role: "SUPERADMIN",
              scopeType: "PLATFORM",
              scopeId: null,
              regionId: null,
            },
          ],
        }
      : SESSION;

  await page.route(
    (url) => url.host === "localhost:4300",
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const query = new URL(req.url()).searchParams;
      const method = req.method();
      let body: Record<string, unknown> = {};
      try {
        body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      } catch {
        // не JSON (файл в PUT загрузки)
      }
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

      // Подписанная ссылка загрузки (ADR-0013): PUT файла без Bearer.
      if (path.startsWith("/storage/upload/") && method === "PUT")
        return route.fulfill({ status: 200, headers: cors });
      if (path === "/auth/admin/login") {
        if (body.login === ADMIN_LOGIN && body.password === ADMIN_PASSWORD)
          return json(route, { token: TOKEN, session: session() }, 201);
        return error(route, 401, "UNAUTHENTICATED", "errors.auth.invalidCredentials");
      }
      if (req.headers()["authorization"] !== `Bearer ${TOKEN}`)
        return error(route, 401, "UNAUTHENTICATED", "errors.unauthenticated");
      if (path === "/auth/session") return json(route, session());
      if (path === "/auth/session/region" && method === "PUT") {
        state.regionChoices.push(body);
        state.activeRegionId = (body.regionId as string | null) ?? null;
        return json(route, session());
      }
      if (path === "/auth/admin/logout") return json(route, null, 204);
      if (path === "/admin/regions")
        return json(route, {
          items: state.platform
            ? [REGION, REGION_B].filter((r) => !state.activeRegionId || r.id === state.activeRegionId)
            : [REGION],
        });

      // Файлы (ADR-0013): заявка → PUT по ссылке → confirm → опрос до ready.
      if (path === "/media/uploads" && method === "POST") {
        const id = uuid();
        const asset = {
          id,
          regionId: REGION_ID,
          ownerType: body.ownerType,
          ownerId: body.ownerId,
          kind: body.kind,
          status: "pending",
          mime: body.mime,
          size: body.size,
          alt: body.alt ?? null,
          width: null,
          height: null,
          rejectReason: null,
          links: [],
          createdAt: NOW,
          polls: 0,
        };
        state.media[id] = asset;
        const { polls: _p, ...dto } = asset;
        return json(
          route,
          {
            asset: dto,
            upload: {
              url: `http://localhost:4300/storage/upload/${id}`,
              method: "PUT",
              headers: { "Content-Type": String(body.mime) },
              expiresAt: "2099-01-01T00:00:00Z",
            },
          },
          201,
        );
      }
      const mediaMatch = /^\/media\/([^/]+)(\/confirm)?$/.exec(path);
      if (mediaMatch) {
        const asset = state.media[mediaMatch[1]!];
        if (!asset) return error(route, 404, "NOT_FOUND", "errors.notFound");
        if (mediaMatch[2]) asset.status = "uploaded";
        // Первый опрос — «обрабатывается», дальше — готово с вариантом w320.
        else if (asset.status !== "ready" && ++asset.polls > 1) {
          asset.status = "ready";
          asset.links = [{ name: "w320", url: PIXEL, width: 320, height: 240, expiresAt: null }];
        }
        const { polls: _p, ...dto } = asset;
        return json(route, dto);
      }

      // Справочники: список и создание.
      const dicts: Record<string, Obj[]> = {
        "/admin/categories": state.categories,
        "/admin/tags": state.tags,
        "/admin/localities": state.localities,
        "/admin/emergency-contacts": state.contacts,
      };
      const dict = dicts[path];
      if (dict && method === "GET") return json(route, { items: dict });
      const dictItem = /^(\/admin\/(?:categories|tags|localities|emergency-contacts))\/([^/]+)$/.exec(path);
      if (dictItem && method === "PATCH") {
        const item = dicts[dictItem[1]!]!.find((x) => x.id === dictItem[2]);
        if (!item) return error(route, 404, "NOT_FOUND", "errors.notFound");
        Object.assign(item, body);
        return json(route, item);
      }
      if (dict && method === "POST") {
        const item = { id: uuid(), sortOrder: 0, active: true, ...body };
        dict.push(item);
        return json(route, item, 201);
      }

      // Места.
      if (path === "/admin/places" && method === "GET") {
        const q = query.get("q")?.toLowerCase();
        const status = query.get("status");
        return json(
          route,
          list(
            state.places.filter(
              (p) =>
                (!status || p.status === status) &&
                (!q || (p.name as { uk: string }).uk.toLowerCase().includes(q)),
            ),
          ),
        );
      }
      if (path === "/admin/places" && method === "POST") {
        const place = {
          id: uuid(),
          status: "draft",
          localityId: null,
          description: null,
          address: null,
          location: null,
          phone: null,
          website: null,
          telegram: null,
          recommended: false,
          hostCapable: false,
          verifiedAt: null,
          firstPublishedAt: null,
          tagIds: [],
          createdAt: NOW,
          updatedAt: NOW,
          ...body,
        };
        state.places.unshift(place);
        return json(route, place, 201);
      }
      const placeMatch = /^\/admin\/places\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (placeMatch) {
        const place = state.places.find((p) => p.id === placeMatch[1]);
        if (!place) return error(route, 404, "NOT_FOUND", "errors.notFound");
        const sub = placeMatch[2];
        if (!sub && method === "GET") return json(route, place);
        if (!sub && method === "DELETE") {
          // Как в api: удаляется только ни разу не публиковавшееся (firstPublishedAt: null).
          if (place.firstPublishedAt !== null)
            return error(route, 409, "CONFLICT", "errors.place.notDeletable", { reason: "not_deletable" });
          state.places.splice(state.places.indexOf(place), 1);
          return json(route, null, 204);
        }
        if (!sub && method === "PATCH") {
          Object.assign(place, body, { updatedAt: NOW });
          return json(route, place);
        }
        if (sub === "publish-check") return json(route, { problems: publishProblems(place) });
        if (sub === "publish") {
          state.publishCalls += 1;
          // Место партнёра, ни разу не опубликованное: первая публикация только решением модерации.
          if (place.organizationId && !place.firstPublishedAt)
            return error(route, 409, "CONFLICT", "errors.place.moderationRequired");
          const problems = publishProblems(place);
          if (problems.length)
            return error(route, 422, "UNPROCESSABLE", "errors.place.notPublishable", {
              reason: "not_publishable",
              problems,
            });
          place.status = "published";
          place.firstPublishedAt ??= NOW;
          return json(route, place);
        }
        if (sub === "suspend" || sub === "archive") {
          // Переходы как в api: suspend — только из published; archive — из любого, кроме архива.
          if (
            (sub === "suspend" && place.status !== "published") ||
            (sub === "archive" && place.status === "archived")
          )
            return error(route, 409, "CONFLICT", "errors.place.invalidTransition", {
              reason: "invalid_transition",
            });
          // Ни разу не публиковавшееся в архив не переводится (CHECK places_published_once) — удаление.
          if (sub === "archive" && place.firstPublishedAt === null)
            return error(route, 409, "CONFLICT", "errors.catalog.archiveNeverPublished", {
              reason: "archive_never_published",
            });
          place.status = sub === "suspend" ? "suspended" : "archived";
          return json(route, place);
        }
        if (sub === "schedule" && method === "GET")
          return json(route, { timezone: "Europe/Kyiv", weekly: [], exceptions: [] });
        if (sub === "schedule" && method === "PUT") return json(route, { timezone: "Europe/Kyiv", ...body });
        const media = (state.placeMedia[place.id as string] ??= []);
        const sorted = () => ({
          items: [...media].sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder)),
        });
        if (sub === "media" && method === "GET") return json(route, sorted());
        if (sub === "media" && method === "POST") {
          const asset = state.media[body.mediaAssetId as string];
          if (!asset)
            return error(route, 422, "UNPROCESSABLE", "errors.place.mediaInvalid", {
              reason: "media_not_found",
            });
          if (body.isCover) for (const m of media) m.isCover = false;
          media.push({
            id: asset.id,
            mediaAssetId: asset.id,
            sortOrder: body.sortOrder ?? media.length,
            isCover: body.isCover === true,
            alt: body.alt ?? null,
            status: asset.status,
            mime: asset.mime,
          });
          return json(route, sorted(), 201);
        }
        const mediaItem = /^media\/([^/]+)$/.exec(sub ?? "");
        if (mediaItem) {
          const item = media.find((m) => m.mediaAssetId === mediaItem[1]);
          if (!item) return error(route, 404, "NOT_FOUND", "errors.notFound");
          if (method === "DELETE") {
            media.splice(media.indexOf(item), 1);
            return json(route, null, 204);
          }
          if (body.isCover) for (const m of media) m.isCover = false;
          Object.assign(item, body);
          return json(route, sorted());
        }
        if (sub === "badge/history") return json(route, { items: [] });

        if (state.noHostAccess && (sub === "host-module" || sub?.startsWith("staff")))
          return error(route, 403, "FORBIDDEN", "errors.forbidden");

        // Модуль готелю (блок 5): пока не сохранён — значения по умолчанию (configured=false).
        if (sub === "host-module" && method === "GET")
          return json(
            route,
            state.hostModules[place.id as string] ?? {
              placeId: place.id,
              regionId: REGION_ID,
              configured: false,
              enabled: false,
              wifiSsid: null,
              wifiPassword: null,
              receptionPhone: null,
              hours: null,
              sections: [],
              services: [],
              updatedAt: null,
            },
          );
        if (sub === "host-module" && method === "PUT") {
          state.hostPuts.push(body);
          const saved = {
            placeId: place.id,
            regionId: REGION_ID,
            configured: true,
            ...body,
            updatedAt: NOW,
          };
          state.hostModules[place.id as string] = saved as unknown as Obj;
          return json(route, saved);
        }

        // Персонал места: назначение по Telegram id/username, снятие.
        const staffList = (state.staff[place.id as string] ??= []);
        if (sub === "staff" && method === "GET") return json(route, { items: staffList });
        if (sub === "staff" && method === "POST") {
          const key = String(body.telegramUserId ?? body.username);
          if (key === "404404") return error(route, 404, "NOT_FOUND", "errors.staff.userNotFound");
          if (staffList.some((m) => m.telegramUserId === key || m.username === key))
            return error(route, 409, "CONFLICT", "errors.staff.alreadyAssigned");
          const member = {
            id: uuid(),
            assignmentId: uuid(),
            userId: uuid(),
            role: body.role ?? "ORG_STAFF",
            telegramUserId: body.telegramUserId ?? "777000111",
            username: body.username ?? null,
            firstName: "Олена",
            notificationsEnabled: false,
            grantedAt: NOW,
          };
          staffList.push(member);
          return json(route, member, 201);
        }
        const staffItem = /^staff\/([^/]+)$/.exec(sub ?? "");
        if (staffItem && method === "DELETE") {
          const i = staffList.findIndex((m) => m.assignmentId === staffItem[1]);
          if (i < 0) return error(route, 404, "NOT_FOUND", "errors.notFound");
          staffList.splice(i, 1);
          return json(route, null, 204);
        }
      }

      // Модерація партнерів (блок 6).
      if (path.startsWith("/admin/moderation/cases")) {
        if (state.noModeration) return error(route, 403, "FORBIDDEN", "errors.forbidden");
        if (path === "/admin/moderation/cases" && method === "GET") {
          const status = query.get("status") ?? "open";
          const placeId = query.get("placeId");
          return json(route, {
            items: state.moderationCases.filter(
              (c) => c.status === status && (!placeId || c.placeId === placeId),
            ),
          });
        }
        const m = /^\/admin\/moderation\/cases\/([^/]+)(?:\/(approve|reject|return))?$/.exec(path);
        const found = m && state.moderationCases.find((c) => c.id === m[1]);
        if (!found) return error(route, 404, "NOT_FOUND", "errors.notFound");
        if (!m[2] && method === "GET")
          return json(route, {
            ...found,
            placeSnapshot: {
              name: found.placeName,
              address: { uk: "вул. Гірська, 1" },
              location: { lat: 48.45, lon: 24.55 },
              schedule: {
                weekly: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }],
                exceptions: [],
              },
              media: [{ mediaAssetId: "m1", isCover: true, alt: { uk: "Фасад кафе" } }],
            },
            snapshotMediaPreview: { m1: "https://example.test/m1.jpg" },
            possibleDuplicates: state.moderationDuplicates,
            partnerNote: null,
            owners: [{ userId: found.submittedBy, displayName: "Олена", username: "olena_cafe" }],
            history: [],
            publishProblems: [],
          });
        if (m[2] && method === "POST") {
          if (found.status === "decided")
            return error(route, 409, "CONFLICT", "errors.moderation.alreadyDecided");
          const decision =
            m[2] === "approve" ? "approve" : m[2] === "reject" ? "reject" : "changes_requested";
          if (m[2] === "approve" ? !body.verificationMethod : !body.reason)
            return error(route, 400, "VALIDATION_FAILED", "errors.validation.failed");
          state.moderationDecisions.push({ id: found.id, decision, body });
          Object.assign(found, {
            status: "decided",
            decision,
            comment: (body.reason ?? body.comment ?? null) as string | null,
            verificationMethod: body.verificationMethod ?? null,
            decidedAt: NOW,
            decidedByName: "admin@example.com",
          });
          return json(route, found);
        }
      }

      // QR.
      if (path === "/admin/qr-points" && method === "GET") return json(route, list(state.qrPoints));
      if (path === "/admin/qr-points" && method === "POST") {
        if (body.type === "campaign" && !body.campaign)
          return error(route, 422, "UNPROCESSABLE", "errors.unprocessable", { reason: "campaign_required" });
        const qr = {
          id: uuid(),
          regionId: REGION_ID,
          code: `e2eQr${String(state.qrPoints.length + 1).padStart(7, "0")}`,
          campaign: null,
          source: null,
          placeId: null,
          venue: null,
          active: true,
          createdAt: NOW,
          updatedAt: NOW,
          ...body,
        };
        state.qrPoints.unshift(qr);
        return json(route, qr, 201);
      }
      const qrMatch = /^\/admin\/qr-points\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (qrMatch) {
        const qr = state.qrPoints.find((x) => x.id === qrMatch[1]);
        if (!qr) return error(route, 404, "NOT_FOUND", "errors.notFound");
        if (qrMatch[2] === "deactivate" || qrMatch[2] === "activate") {
          qr.active = qrMatch[2] === "activate";
          return json(route, qr);
        }
        if (qrMatch[2] === "print") {
          if (!qr.active)
            return error(route, 409, "CONFLICT", "errors.qr.inactive", { reason: "qr_point_inactive" });
          return json(route, {
            id: qr.id,
            code: qr.code,
            label: qr.label,
            deepLink: `https://t.me/tourist_guide_bot?startapp=${String(qr.code)}`,
            svg: SVG,
          });
        }
        return json(route, qr);
      }

      // Сценарии «Мій план».
      const scenarioSummary = (sc: Obj) => {
        const { items, ...rest } = sc;
        return { ...rest, itemCount: (items as unknown[]).length };
      };
      const scenarioFrom = (
        id: string,
        version: number,
        status: string,
        b: Record<string, unknown>,
      ): Obj => ({
        regionId: REGION_ID,
        description: null,
        tags: [],
        seasons: [],
        adLabel: null,
        sortOrder: 0,
        updatedAt: NOW,
        ...b,
        id,
        version,
        status,
        items: ((b.items as Record<string, unknown>[]) ?? []).map((it, i) => ({
          position: i,
          placeName: state.places.find((p) => p.id === it.placeId)?.name ?? null,
          placeStatus: "published",
          timeHint: null,
          durationMin: null,
          note: null,
          alternatives: [],
          ...it,
          id: uuid(),
        })),
      });
      if (path === "/admin/scenarios" && method === "GET") {
        const status = query.get("status");
        return json(
          route,
          list(state.scenarios.filter((x) => !status || x.status === status).map(scenarioSummary)),
        );
      }
      if (path === "/admin/scenarios" && method === "POST") {
        state.scenarioWrites.push(body);
        if (state.scenarios.some((x) => x.code === body.code))
          return error(route, 409, "CONFLICT", "errors.scenario.codeTaken");
        const sc = scenarioFrom(uuid(), 1, "draft", body);
        state.scenarios.push(sc);
        return json(route, sc, 201);
      }
      const scenarioMatch = /^\/admin\/scenarios\/([^/]+)(\/status)?$/.exec(path);
      if (scenarioMatch) {
        const sc = state.scenarios.find((x) => x.id === scenarioMatch[1]);
        if (!sc) return error(route, 404, "NOT_FOUND", "errors.notFound");
        if (scenarioMatch[2] && method === "PATCH") {
          if (body.status === "published" && (sc.items as unknown[]).length === 0)
            return error(route, 422, "UNPROCESSABLE", "errors.unprocessable", { reason: "scenario_empty" });
          sc.status = body.status;
          return json(route, scenarioSummary(sc));
        }
        if (method === "PUT") {
          state.scenarioWrites.push(body);
          const next = scenarioFrom(sc.id, Number(sc.version) + 1, String(sc.status), body);
          Object.assign(sc, next);
          return json(route, sc);
        }
        return json(route, sc);
      }

      if (path === "/admin/audit-logs")
        return json(
          route,
          list([
            {
              id: uuid(),
              actorType: "user",
              actorUserId: SESSION.userId,
              regionId: REGION_ID,
              action: "place.create",
              entityType: "place",
              entityId: state.places[0]?.id ?? null,
              oldValues: null,
              newValues: { status: "draft" },
              reason: null,
              requestId: "e2e",
              roleAssignmentId: null,
              createdAt: NOW,
            },
          ]),
        );
      return error(route, 404, "NOT_FOUND", "errors.notFound");
    },
  );
  return state;
}
