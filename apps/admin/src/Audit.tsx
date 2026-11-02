// Журнал аудита: GET /admin/audit-logs с фильтрами и курсором «Показати ще».
import { useCallback, useEffect, useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, grantRegions, type ApiError, type ApiSchemas } from "./api.js";
import { dayStartIso, formatDate } from "./dates.js";
import { ErrorBox, Field, row, SmallButton, Table, Td, useAdmin, useBusy, useLoad } from "./ui.js";

type Entry = ApiSchemas["AuditLogDto"];
type Filters = {
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string;
  from: string;
  to: string;
};
const EMPTY: Filters = { action: "", entityType: "", entityId: "", actorUserId: "", from: "", to: "" };

export function AuditScreen() {
  const { api, session } = useAdmin();
  const { t, locale } = useT();
  // Границы дней «з»/«до» — по таймзоне региона сессии (нет региона — Europe/Kyiv, зона тестового региона).
  const [regions] = useLoad(() => call(api.GET("/admin/regions")), []);
  const regionId = session.activeRegionId ?? grantRegions(session)[0];
  const timezone =
    (regions?.ok && regions.data.items.find((r) => r.id === regionId)?.timezone) || "Europe/Kyiv";
  const [acting, act] = useBusy();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const query = {
        ...(filters.action && { action: filters.action }),
        ...(filters.entityType && { entityType: filters.entityType }),
        ...(filters.entityId && { entityId: filters.entityId }),
        ...(filters.actorUserId && { actorUserId: filters.actorUserId }),
        ...(filters.from && { from: dayStartIso(filters.from, timezone) }),
        // «По» включительно: api берёт to не включительно — передаём начало следующего дня.
        ...(filters.to && { to: dayStartIso(filters.to, timezone, 1) }),
        ...(after && { cursor: after }),
        limit: 50,
      };
      const res = await call(api.GET("/admin/audit-logs", { params: { query } }));
      setLoaded(true);
      if (!res.ok) {
        if (!after) setItems([]);
        return setError(res.error);
      }
      setError(null);
      setItems((prev) => (after ? [...prev, ...res.data.items] : res.data.items));
      setCursor(res.data.nextCursor);
    },
    [api, filters, timezone],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const set = (k: keyof Filters) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <Stack gap={2}>
      <form
        aria-label={t("admin.filters")}
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <div style={row}>
          <Field label={t("admin.audit.action")} value={draft.action} onChange={set("action")} />
          <Field label={t("admin.audit.entityType")} value={draft.entityType} onChange={set("entityType")} />
          <Field label={t("admin.audit.entityId")} value={draft.entityId} onChange={set("entityId")} />
          <Field label={t("admin.audit.actor")} value={draft.actorUserId} onChange={set("actorUserId")} />
          <Field label={t("admin.audit.from")} type="date" value={draft.from} onChange={set("from")} />
          <Field label={t("admin.audit.to")} type="date" value={draft.to} onChange={set("to")} />
          <SmallButton type="submit">{t("admin.apply")}</SmallButton>
        </div>
      </form>
      <ErrorBox error={error} />
      {loaded && (items.length > 0 || !error) && (
        <Table
          caption={t("admin.audit")}
          head={[
            t("admin.audit.time"),
            t("admin.audit.action"),
            t("admin.audit.entityType"),
            t("admin.audit.entityId"),
            t("admin.audit.actor"),
            t("admin.audit.reason"),
            t("admin.audit.changes"),
          ]}
        >
          {items.map((e) => (
            <tr key={e.id}>
              <Td>{formatDate(e.createdAt, locale)}</Td>
              <Td>{e.action}</Td>
              <Td>{e.entityType}</Td>
              <Td style={{ wordBreak: "break-all" }}>{e.entityId ?? "—"}</Td>
              <Td style={{ wordBreak: "break-all" }}>{e.actorUserId ?? t("admin.audit.system")}</Td>
              <Td>{e.reason ?? "—"}</Td>
              <Td>
                {(e.oldValues || e.newValues) && (
                  <details>
                    <summary>{t("admin.audit.show")}</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
                      {JSON.stringify({ old: e.oldValues, new: e.newValues }, null, 2)}
                    </pre>
                  </details>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {loaded && !error && items.length === 0 && <p>{t("admin.empty")}</p>}
      {cursor && (
        <div>
          <SmallButton disabled={acting} onClick={() => act(() => load(cursor))}>
            {t("admin.more")}
          </SmallButton>
        </div>
      )}
    </Stack>
  );
}
