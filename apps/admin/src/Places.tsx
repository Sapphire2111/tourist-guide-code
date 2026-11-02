// Места (AD03): список с фильтрами (статус, категория, поиск) и курсором «Показати ще».
import { useCallback, useEffect, useState } from "react";
import { Link, Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import {
  ErrorBox,
  Field,
  row,
  SelectField,
  SmallButton,
  Table,
  Td,
  useAdmin,
  useLoad,
  useLocalized,
  useBusy,
} from "./ui.js";

type Place = ApiSchemas["PlaceDto"];
export const PLACE_STATUSES = ["draft", "published", "suspended", "archived"] as const;

export function PlacesScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [acting, act] = useBusy();
  const l = useLocalized();
  const [cats] = useLoad(() => call(api.GET("/admin/categories")), []);
  const categories = cats?.ok ? cats.data.items : [];
  const [draft, setDraft] = useState({ status: "", categoryId: "", q: "" });
  const [filters, setFilters] = useState(draft);
  const [items, setItems] = useState<Place[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const query = {
        ...(filters.status && { status: filters.status as Place["status"] }),
        ...(filters.categoryId && { categoryId: filters.categoryId }),
        ...(filters.q.trim() && { q: filters.q.trim() }),
        ...(after && { cursor: after }),
      };
      const res = await call(api.GET("/admin/places", { params: { query } }));
      setLoaded(true);
      if (!res.ok) {
        if (!after) setItems([]);
        return setError(res.error);
      }
      setError(null);
      setItems((prev) => (after ? [...prev, ...res.data.items] : res.data.items));
      setCursor(res.data.nextCursor);
    },
    [api, filters],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Stack gap={2}>
      <div>
        <Link to="/places/new">{t("admin.place.new")}</Link>
      </div>
      <form
        aria-label={t("admin.filters")}
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <div style={row}>
          <SelectField
            label={t("admin.field.status")}
            value={draft.status}
            empty={t("admin.all")}
            options={PLACE_STATUSES.map((s) => ({ value: s, label: tDynamic(`admin.placeStatus.${s}`) }))}
            onChange={(status) => setDraft((d) => ({ ...d, status }))}
          />
          <SelectField
            label={t("admin.field.category")}
            value={draft.categoryId}
            empty={t("admin.all")}
            options={categories.map((c) => ({ value: c.id, label: l(c.name) }))}
            onChange={(categoryId) => setDraft((d) => ({ ...d, categoryId }))}
          />
          <Field label={t("admin.search")} value={draft.q} onChange={(q) => setDraft((d) => ({ ...d, q }))} />
          <SmallButton type="submit">{t("admin.apply")}</SmallButton>
        </div>
      </form>
      <ErrorBox error={error} />
      {loaded && (items.length > 0 || !error) && (
        <Table
          caption={t("admin.places")}
          head={[t("admin.field.name"), t("admin.field.category"), t("admin.field.status"), t("admin.badge")]}
        >
          {items.map((p) => (
            <tr key={p.id}>
              <Td>
                <Link to={`/places/${p.id}`}>{l(p.name)}</Link>
              </Td>
              <Td>{l(categories.find((c) => c.id === p.categoryId)?.name)}</Td>
              <Td>{tDynamic(`admin.placeStatus.${p.status}`)}</Td>
              <Td>{p.recommended ? t("admin.badge.on") : ""}</Td>
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
