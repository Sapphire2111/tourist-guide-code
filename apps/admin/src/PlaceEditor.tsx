// Карточка места (AD03): поля, статус (публикация с причинами 422), бейдж «Ми рекомендуємо», график, фото.
import { useState } from "react";
import { Link, Stack, useRoute, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { formatDate } from "./dates.js";
import { PlaceMedia } from "./PlaceMedia.js";
import { PlaceHostModule } from "./HostModule.js";
import { PlaceStaff } from "./PlaceStaff.js";
import { PlaceSchedule } from "./PlaceSchedule.js";
import {
  CheckboxField,
  ErrorBox,
  Field,
  Form,
  fromLocalized,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  row,
  SelectField,
  SmallButton,
  toLocalized,
  useAdmin,
  useLoad,
  useLocalized,
  type LocalizedValue,
  useBusy,
} from "./ui.js";

type Place = ApiSchemas["PlaceDto"];
/** Статусы партнёрской модерации (блок 6): у места есть заявка. */
const MODERATION_STATUSES: readonly Place["status"][] = [
  "pending_moderation",
  "changes_requested",
  "rejected",
];

type PlaceForm = {
  name: LocalizedValue;
  description: LocalizedValue;
  address: LocalizedValue;
  lat: string;
  lon: string;
  phone: string;
  website: string;
  telegram: string;
  categoryId: string;
  localityId: string;
  tagIds: string[];
};

function toForm(p?: Place): PlaceForm {
  return {
    name: fromLocalized(p?.name),
    description: fromLocalized(p?.description),
    address: fromLocalized(p?.address),
    lat: p?.location ? String(p.location.lat) : "",
    lon: p?.location ? String(p.location.lon) : "",
    phone: p?.phone ?? "",
    website: p?.website ?? "",
    telegram: p?.telegram ?? "",
    categoryId: p?.categoryId ?? "",
    localityId: p?.localityId ?? "",
    tagIds: p?.tagIds ?? [],
  };
}

/** Форма → тело POST/PATCH: пустые необязательные поля — null. */
export function placeBody(f: PlaceForm) {
  const lat = f.lat.trim() === "" ? NaN : Number(f.lat);
  const lon = f.lon.trim() === "" ? NaN : Number(f.lon);
  const opt = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    name: toLocalized(f.name) ?? { uk: "" },
    description: toLocalized(f.description),
    address: toLocalized(f.address),
    location: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    phone: opt(f.phone),
    website: opt(f.website),
    telegram: opt(f.telegram.replace(/^@/, "")),
    categoryId: f.categoryId,
    localityId: opt(f.localityId),
    tagIds: f.tagIds,
  };
}

function PlaceFields({ form, set }: { form: PlaceForm; set: (patch: Partial<PlaceForm>) => void }) {
  const { api } = useAdmin();
  const { t } = useT();
  const l = useLocalized();
  const [cats] = useLoad(() => call(api.GET("/admin/categories")), []);
  const [tags] = useLoad(() => call(api.GET("/admin/tags")), []);
  const [localities] = useLoad(() => call(api.GET("/admin/localities")), []);
  return (
    <>
      <LocalizedField
        label={t("admin.field.name")}
        value={form.name}
        onChange={(name) => set({ name })}
        required
      />
      <LocalizedField
        label={t("admin.field.description")}
        value={form.description}
        onChange={(description) => set({ description })}
        multiline
      />
      <LocalizedField
        label={t("admin.field.address")}
        value={form.address}
        onChange={(address) => set({ address })}
      />
      <div style={grid2}>
        <SelectField
          label={t("admin.field.category")}
          value={form.categoryId}
          required
          empty={t("admin.choose")}
          options={(cats?.ok ? cats.data.items : []).map((c) => ({ value: c.id, label: l(c.name) }))}
          onChange={(categoryId) => set({ categoryId })}
        />
        <SelectField
          label={t("admin.field.locality")}
          value={form.localityId}
          empty={t("admin.none")}
          options={(localities?.ok ? localities.data.items : []).map((c) => ({
            value: c.id,
            label: l(c.name),
          }))}
          onChange={(localityId) => set({ localityId })}
        />
        <Field
          label={t("admin.field.lat")}
          type="number"
          step="any"
          value={form.lat}
          onChange={(lat) => set({ lat })}
        />
        <Field
          label={t("admin.field.lon")}
          type="number"
          step="any"
          value={form.lon}
          onChange={(lon) => set({ lon })}
        />
        <Field
          label={t("admin.field.phone")}
          type="tel"
          placeholder="+380…"
          value={form.phone}
          onChange={(phone) => set({ phone })}
        />
        <Field
          label={t("admin.field.website")}
          type="url"
          placeholder="https://"
          value={form.website}
          onChange={(website) => set({ website })}
        />
        <Field
          label={t("admin.field.telegram")}
          value={form.telegram}
          onChange={(telegram) => set({ telegram })}
        />
      </div>
      {tags?.ok && tags.data.items.length > 0 && (
        <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
          <legend>{t("admin.tags")}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {tags.data.items.map((tag) => (
              <CheckboxField
                key={tag.id}
                label={l(tag.name)}
                checked={form.tagIds.includes(tag.id)}
                onChange={(on) =>
                  set({ tagIds: on ? [...form.tagIds, tag.id] : form.tagIds.filter((x) => x !== tag.id) })
                }
              />
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}

/** Статус: публикация / приостановка / архив с причиной; 422 — список проблем публикации. */
function PlaceStatus({ place, onChange }: { place: Place; onChange: (p: Place) => void }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [acting, act] = useBusy();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);

  const transition = async (action: "publish" | "suspend" | "archive") => {
    setNotice(null);
    const params = {
      params: { path: { id: place.id } },
      body: reason.trim() ? { reason: reason.trim() } : {},
    };
    const res = await call(
      action === "publish"
        ? api.POST("/admin/places/{id}/publish", params)
        : action === "suspend"
          ? api.POST("/admin/places/{id}/suspend", params)
          : api.POST("/admin/places/{id}/archive", params),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setProblems(null);
    setReason("");
    setNotice(tDynamic(`admin.placeStatus.${res.data.status}`));
    onChange(res.data);
  };

  const check = async () => {
    const res = await call(
      api.GET("/admin/places/{id}/publish-check", { params: { path: { id: place.id } } }),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setProblems(res.data.problems);
  };

  const s = place.status;
  return (
    <section aria-labelledby="place-status">
      <Stack gap={2}>
        <h2 id="place-status" style={{ margin: 0 }}>
          {t("admin.field.status")}: {tDynamic(`admin.placeStatus.${s}`)}
        </h2>
        <Field label={t("admin.reason")} value={reason} onChange={setReason} />
        <div style={row}>
          {(s === "draft" || s === "suspended" || s === "archived") &&
            !(s === "draft" && place.organizationId) && (
              <SmallButton disabled={acting} onClick={() => act(() => transition("publish"))}>
                {t("admin.place.publish")}
              </SmallButton>
            )}
          {s === "published" && (
            <SmallButton disabled={acting} onClick={() => act(() => transition("suspend"))}>
              {t("admin.place.suspend")}
            </SmallButton>
          )}
          {s !== "archived" && !MODERATION_STATUSES.includes(s) && (
            <SmallButton disabled={acting} onClick={() => act(() => transition("archive"))}>
              {t("admin.place.archive")}
            </SmallButton>
          )}
          <SmallButton disabled={acting} onClick={() => act(() => check())}>
            {t("admin.place.check")}
          </SmallButton>
        </div>
        <ErrorBox error={error} />
        {problems && (
          <div role="status">
            {problems.length === 0 ? (
              <p style={{ margin: 0 }}>{t("admin.place.checkOk")}</p>
            ) : (
              <ul style={{ margin: 0 }}>
                {problems.map((p) => (
                  <li key={p}>{tDynamic(`admin.problem.${p}`)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Notice text={notice} />
      </Stack>
    </section>
  );
}

/** Бейдж «Ми рекомендуємо» (D-32): выдача/снятие с причиной и история. */
function PlaceBadge({ place, onChange }: { place: Place; onChange: (p: Place) => void }) {
  const { api } = useAdmin();
  const { t, tDynamic, locale } = useT();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [history, reload] = useLoad(
    () => call(api.GET("/admin/places/{id}/badge/history", { params: { path: { id: place.id } } })),
    [place.id],
  );
  const toggle = async () => {
    const params = { params: { path: { id: place.id } }, body: { reason: reason.trim() } };
    const res = await call(
      place.recommended
        ? api.DELETE("/admin/places/{id}/badge", params)
        : api.POST("/admin/places/{id}/badge", params),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setReason("");
    onChange(res.data);
    reload();
  };
  return (
    <section aria-labelledby="place-badge">
      <Stack gap={2}>
        <h2 id="place-badge" style={{ margin: 0 }}>
          {t("admin.badge")}: {place.recommended ? t("admin.badge.on") : t("admin.badge.off")}
        </h2>
        <Form
          label={t("admin.badge")}
          onSubmit={toggle}
          submitLabel={place.recommended ? t("admin.badge.revoke") : t("admin.badge.grant")}
          error={error}
        >
          <Field label={t("admin.reason")} value={reason} onChange={setReason} required />
        </Form>
        <Loaded result={history}>
          {(h) =>
            h.items.length > 0 && (
              <ul aria-label={t("admin.badge.history")}>
                {h.items.map((e) => (
                  <li key={e.id}>
                    {formatDate(e.createdAt, locale)} — {tDynamic(`admin.badge.${e.action}`)}: {e.reason}
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </Stack>
    </section>
  );
}

function Editor({ place }: { place?: Place }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const [, navigate] = useRoute();
  const [current, setCurrent] = useState(place);
  const [form, setForm] = useState(() => toForm(place));
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const body = placeBody(form);
    const res = current
      ? await call(api.PATCH("/admin/places/{id}", { params: { path: { id: current.id } }, body }))
      : await call(api.POST("/admin/places", { body }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setNotice(t("admin.saved"));
    setCurrent(res.data);
    if (!current) navigate(`/places/${res.data.id}`, { replace: true });
  };

  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>
        <Link to="/places">← {t("admin.places")}</Link>
      </p>
      <h2 style={{ margin: 0 }}>{current ? l(current.name) : t("admin.place.new")}</h2>
      {current && (
        <p style={{ margin: 0 }}>
          {t("admin.field.status")}: {tDynamic(`admin.placeStatus.${current.status}`)}
        </p>
      )}
      {current && MODERATION_STATUSES.includes(current.status) && (
        <p role="note" style={{ margin: 0 }}>
          {t("admin.place.moderationNote", { status: tDynamic(`admin.placeStatus.${current.status}`) })}{" "}
          <ModerationLink placeId={current.id} />
        </p>
      )}
      <Form
        label={t("admin.place.form")}
        onSubmit={save}
        submitLabel={t("admin.save")}
        error={error}
        busy={busy}
      >
        <PlaceFields form={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} />
        <Notice text={notice} />
      </Form>
      {current && (
        <>
          <PlaceStatus place={current} onChange={setCurrent} />
          <PlaceBadge place={current} onChange={setCurrent} />
          <PlaceSchedule placeId={current.id} />
          <PlaceMedia placeId={current.id} />
          {current.hostCapable && <PlaceHostModule placeId={current.id} />}
          <PlaceStaff placeId={current.id} hostCapable={current.hostCapable} />
        </>
      )}
    </Stack>
  );
}

/** Ссылка на последнюю заявку места (открытая, иначе решённая); нет доступа или заявок — на очередь. */
function ModerationLink({ placeId }: { placeId: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [found] = useLoad(async () => {
    for (const status of ["open", "decided"] as const) {
      const res = await call(api.GET("/admin/moderation/cases", { params: { query: { status, placeId } } }));
      if (!res.ok) return res;
      if (res.data.items.length > 0) return res;
    }
    return { ok: true as const, data: { items: [] } };
  }, [placeId]);
  const first = found?.ok ? found.data.items[0] : undefined;
  return first ? (
    <Link to={`/moderation/${first.id}`}>{t("admin.place.moderationCase")}</Link>
  ) : (
    <Link to="/moderation">{t("admin.place.moderationLink")}</Link>
  );
}

export function PlaceEditorScreen({ id }: { id: string | null }) {
  const { api } = useAdmin();
  const [result] = useLoad(
    () =>
      id
        ? call(api.GET("/admin/places/{id}", { params: { path: { id } } }))
        : Promise.resolve({ ok: true as const, data: undefined }),
    [id],
  );
  return <Loaded result={result}>{(place) => <Editor key={place?.id ?? "new"} place={place} />}</Loaded>;
}
