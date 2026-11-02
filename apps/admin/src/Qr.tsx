// QR-коды (AD04): список с фильтрами, создание (тип, кампания, место, «Про заклад» для hotel),
// деактивация/активация и страница печати (SVG + ссылка из GET /admin/qr-points/{id}/print).
import { useCallback, useEffect, useState } from "react";
import { Button, Link, Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import {
  emptyLocalized,
  ErrorBox,
  Field,
  Form,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  row,
  SelectField,
  SmallButton,
  Table,
  Td,
  toLocalized,
  useAdmin,
  useLoad,
  useLocalized,
  type LocalizedValue,
  useBusy,
} from "./ui.js";

type Qr = ApiSchemas["AdminQrPointDto"];
type QrType = Qr["type"];
export const QR_TYPES: QrType[] = ["hotel", "place", "region", "campaign"];

type Venue = {
  name: LocalizedValue;
  description: LocalizedValue;
  address: LocalizedValue;
  phone: string;
  website: string;
  telegram: string;
};
const emptyVenue = (): Venue => ({
  name: emptyLocalized(),
  description: emptyLocalized(),
  address: emptyLocalized(),
  phone: "",
  website: "",
  telegram: "",
});

/** Заполнено ли хоть одно поле «Про заклад». */
export function venueFilled(v: Venue): boolean {
  return (
    [v.name, v.description, v.address].some((x) => x.uk.trim() || x.en.trim()) ||
    [v.phone, v.website, v.telegram].some((x) => x.trim() !== "")
  );
}

/** Тело POST /admin/qr-points: пустые поля не передаются; venue — только у hotel с названием. */
export function qrBody(
  f: { type: QrType; label: string; campaign: string; source: string; placeId: string },
  v: Venue,
) {
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  const name = toLocalized(v.name);
  const venue =
    f.type === "hotel" && name
      ? {
          name,
          description: toLocalized(v.description),
          address: toLocalized(v.address),
          phone: opt(v.phone) ?? null,
          website: opt(v.website) ?? null,
          telegram: opt(v.telegram.replace(/^@/, "")) ?? null,
        }
      : undefined;
  return {
    type: f.type,
    label: f.label.trim(),
    campaign: opt(f.campaign),
    source: opt(f.source),
    placeId: opt(f.placeId),
    venue,
  };
}

function CreateQr({ onCreated }: { onCreated: () => void }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  // Место — поиск по названию (q) с ограничением выдачи, а не весь каталог.
  const [placeDraft, setPlaceDraft] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [places] = useLoad(
    () =>
      call(
        api.GET("/admin/places", {
          params: { query: { limit: 20, ...(placeQuery && { q: placeQuery }) } },
        }),
      ),
    [placeQuery],
  );
  const [form, setForm] = useState({
    type: "hotel" as QrType,
    label: "",
    campaign: "",
    source: "",
    placeId: "",
  });
  const [venue, setVenue] = useState(emptyVenue);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async () => {
    setNotice(null);
    // «Про заклад» без названия не сохраняется молча: заполнено любое поле — название обязательно.
    if (form.type === "hotel" && venueFilled(venue) && !venue.name.uk.trim())
      return setError({ status: 0, messageKey: "admin.qr.venueNameRequired" });
    const res = await call(api.POST("/admin/qr-points", { body: qrBody(form, venue) }));
    if (!res.ok) return setError(res.error);
    setError(null);
    setForm({ type: form.type, label: "", campaign: "", source: "", placeId: "" });
    setVenue(emptyVenue());
    setNotice(t("admin.qr.created", { code: res.data.code }));
    onCreated();
  };
  return (
    <Form label={t("admin.qr.new")} onSubmit={submit} submitLabel={t("admin.create")} error={error}>
      <div style={grid2}>
        <SelectField
          label={t("admin.field.type")}
          value={form.type}
          options={QR_TYPES.map((x) => ({ value: x, label: tDynamic(`admin.qrType.${x}`) }))}
          onChange={(type) => set({ type: type as QrType })}
        />
        <Field label={t("admin.qr.label")} value={form.label} required onChange={(label) => set({ label })} />
        <Field
          label={t("admin.qr.campaign")}
          value={form.campaign}
          required={form.type === "campaign"}
          onChange={(campaign) => set({ campaign })}
        />
        <Field label={t("admin.qr.source")} value={form.source} onChange={(source) => set({ source })} />
        <div style={row}>
          <Field label={t("admin.qr.placeSearch")} value={placeDraft} onChange={setPlaceDraft} />
          <SmallButton onClick={() => setPlaceQuery(placeDraft.trim())}>{t("admin.qr.find")}</SmallButton>
        </div>
        <SelectField
          label={t("admin.qr.place")}
          value={form.placeId}
          empty={t("admin.none")}
          options={(places?.ok ? places.data.items : []).map((p) => ({ value: p.id, label: l(p.name) }))}
          onChange={(placeId) => set({ placeId })}
        />
      </div>
      {form.type === "hotel" && (
        <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
          <legend>{t("admin.qr.venue")}</legend>
          <Stack gap={2}>
            <LocalizedField
              label={t("admin.field.name")}
              value={venue.name}
              onChange={(name) => setVenue((v) => ({ ...v, name }))}
            />
            <LocalizedField
              label={t("admin.field.description")}
              value={venue.description}
              multiline
              onChange={(description) => setVenue((v) => ({ ...v, description }))}
            />
            <LocalizedField
              label={t("admin.field.address")}
              value={venue.address}
              onChange={(address) => setVenue((v) => ({ ...v, address }))}
            />
            <div style={grid2}>
              <Field
                label={t("admin.field.phone")}
                type="tel"
                value={venue.phone}
                onChange={(phone) => setVenue((v) => ({ ...v, phone }))}
              />
              <Field
                label={t("admin.field.website")}
                type="url"
                value={venue.website}
                onChange={(website) => setVenue((v) => ({ ...v, website }))}
              />
              <Field
                label={t("admin.field.telegram")}
                value={venue.telegram}
                onChange={(telegram) => setVenue((v) => ({ ...v, telegram }))}
              />
            </div>
          </Stack>
        </fieldset>
      )}
      <Notice text={notice} />
    </Form>
  );
}

export function QrScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [acting, act] = useBusy();
  const [draft, setDraft] = useState({ type: "", active: "", campaign: "" });
  const [filters, setFilters] = useState(draft);
  const [items, setItems] = useState<Qr[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const query = {
        ...(filters.type && { type: filters.type as QrType }),
        ...(filters.active && { active: filters.active === "true" }),
        ...(filters.campaign.trim() && { campaign: filters.campaign.trim() }),
        ...(after && { cursor: after }),
      };
      const res = await call(api.GET("/admin/qr-points", { params: { query } }));
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

  const toggle = async (qr: Qr) => {
    const params = { params: { path: { id: qr.id } } };
    const res = await call(
      qr.active
        ? api.POST("/admin/qr-points/{id}/deactivate", params)
        : api.POST("/admin/qr-points/{id}/activate", params),
    );
    if (!res.ok) return setError(res.error);
    setItems((list) => list.map((x) => (x.id === qr.id ? res.data : x)));
  };

  return (
    <Stack gap={3}>
      <form
        aria-label={t("admin.filters")}
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(draft);
        }}
      >
        <div style={row}>
          <SelectField
            label={t("admin.field.type")}
            value={draft.type}
            empty={t("admin.all")}
            options={QR_TYPES.map((x) => ({ value: x, label: tDynamic(`admin.qrType.${x}`) }))}
            onChange={(type) => setDraft((d) => ({ ...d, type }))}
          />
          <SelectField
            label={t("admin.field.active")}
            value={draft.active}
            empty={t("admin.all")}
            options={[
              { value: "true", label: t("admin.qr.active") },
              { value: "false", label: t("admin.qr.inactive") },
            ]}
            onChange={(active) => setDraft((d) => ({ ...d, active }))}
          />
          <Field
            label={t("admin.qr.campaign")}
            value={draft.campaign}
            onChange={(campaign) => setDraft((d) => ({ ...d, campaign }))}
          />
          <SmallButton type="submit">{t("admin.apply")}</SmallButton>
        </div>
      </form>
      <ErrorBox error={error} />
      {loaded && (
        <Table
          caption={t("admin.qr")}
          head={[
            t("admin.qr.label"),
            t("admin.qr.code"),
            t("admin.field.type"),
            t("admin.qr.campaign"),
            t("admin.field.status"),
            t("admin.actions"),
          ]}
        >
          {items.map((qr) => (
            <tr key={qr.id}>
              <Td>{qr.label}</Td>
              <Td>
                <code>{qr.code}</code>
              </Td>
              <Td>{tDynamic(`admin.qrType.${qr.type}`)}</Td>
              <Td>{qr.campaign ?? "—"}</Td>
              <Td>{qr.active ? t("admin.qr.active") : t("admin.qr.inactive")}</Td>
              <Td>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <SmallButton
                    aria-label={`${qr.active ? t("admin.qr.deactivate") : t("admin.qr.activate")}: ${qr.label}`}
                    disabled={acting}
                    onClick={() => act(() => toggle(qr))}
                  >
                    {qr.active ? t("admin.qr.deactivate") : t("admin.qr.activate")}
                  </SmallButton>
                  {qr.active && (
                    <Link to={`/qr/${qr.id}/print`} aria-label={`${t("admin.qr.print")}: ${qr.label}`}>
                      {t("admin.qr.print")}
                    </Link>
                  )}
                </div>
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
      <h2 style={{ margin: 0 }}>{t("admin.qr.new")}</h2>
      <CreateQr onCreated={() => void load(null)} />
    </Stack>
  );
}

/** Страница печати: QR (SVG сервера как изображение), подпись, ссылка; кнопка — печать браузера. */
export function QrPrintScreen({ id }: { id: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result] = useLoad(
    () => call(api.GET("/admin/qr-points/{id}/print", { params: { path: { id } } })),
    [id],
  );
  return (
    <Stack gap={2}>
      <p className="no-print" style={{ margin: 0 }}>
        <Link to="/qr">← {t("admin.qr")}</Link>
      </p>
      <Loaded result={result}>
        {(p) => (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.svg)}`}
              alt={t("admin.qr.imageAlt", { label: p.label })}
              width={320}
              height={320}
            />
            <p style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700 }}>{p.label}</p>
            <p style={{ margin: 0 }}>
              <a href={p.deepLink}>{p.deepLink}</a>
            </p>
            <p style={{ margin: 0 }}>
              {t("admin.qr.code")}: <code>{p.code}</code>
            </p>
            <Button className="no-print" onClick={() => window.print()}>
              {t("admin.qr.printNow")}
            </Button>
          </div>
        )}
      </Loaded>
    </Stack>
  );
}
