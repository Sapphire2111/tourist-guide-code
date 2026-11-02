// P06 редактор заведения: поля по шаблону, график, фото; статус модерации и «Надіслати на модерацію» (P12).
// Права — abilities/editable из ответа API: менеджер не правит поля личности, у опубликованного они заблокированы
// (409 identityChangeRequiresModeration — через админа региона). PATCH — только изменённые поля.
import { useId, useState, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { card, listStyle } from "../guide/parts.js";
import { NotFoundError } from "../guide/types.js";
import { useLiveAsync } from "../host/context.js";
import { useErrorText } from "../host/errors.js";
import { ApiCallError } from "../host/types.js";
import { usePartner } from "./context.js";
import type { PartnerField, PartnerPlace, PlacePatch, Schedule } from "./partner-api.js";
import { fieldKey, Live, PlaceStatusInfo, type Message } from "./parts.js";

const SUBMITTABLE = new Set(["draft", "changes_requested", "rejected"]);
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

type Form = {
  name: string;
  categoryId: string;
  address: string;
  lat: string;
  lon: string;
  description: string;
  phone: string;
  website: string;
  telegram: string;
};

export function formOf(p: PartnerPlace): Form {
  return {
    name: p.name.uk,
    categoryId: p.categoryId,
    address: p.address?.uk ?? "",
    lat: p.location ? String(p.location.lat) : "",
    lon: p.location ? String(p.location.lon) : "",
    description: p.description?.uk ?? "",
    phone: p.phone ?? "",
    website: p.website ?? "",
    telegram: p.telegram ?? "",
  };
}

const text = (v: string) => (v.trim() ? { uk: v.trim() } : null);
const str = (v: string) => (v.trim() ? v.trim() : null);

/**
 * Изменённые поля формы → тело PATCH. Поля личности — только если их разрешено менять (identity).
 * "bad_location" — координаты заданы не обе или не числами.
 */
export function patchOf(place: PartnerPlace, form: Form, identity: boolean): PlacePatch | "bad_location" {
  const before = formOf(place);
  const patch: PlacePatch = {};
  const changed = (k: keyof Form) => form[k].trim() !== before[k].trim();
  if (identity) {
    if (changed("name") && form.name.trim()) patch.name = { uk: form.name.trim() };
    if (changed("categoryId") && form.categoryId) patch.categoryId = form.categoryId;
    if (changed("address")) patch.address = text(form.address);
    if (changed("lat") || changed("lon")) {
      if (!form.lat.trim() && !form.lon.trim()) patch.location = null;
      else {
        const lat = Number(form.lat.replace(",", "."));
        const lon = Number(form.lon.replace(",", "."));
        if (!form.lat.trim() || !form.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon))
          return "bad_location";
        patch.location = { lat, lon };
      }
    }
  }
  if (changed("description")) patch.description = text(form.description);
  if (changed("phone")) patch.phone = str(form.phone);
  if (changed("website")) patch.website = str(form.website);
  if (changed("telegram")) patch.telegram = str(form.telegram.replace(/^@/, ""));
  return patch;
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} style={{ display: "block" }}>
      {label}
      {children(id)}
    </label>
  );
}

function MissingFields({ fields }: { fields: readonly PartnerField[] }) {
  const { t } = useT();
  if (!fields.length) return <p data-testid="missing-fields">{t("miniapp.partner.editor.complete")}</p>;
  return (
    <p data-testid="missing-fields">
      {t("miniapp.partner.editor.missing", { fields: fields.map((f) => t(fieldKey(f))).join(", ") })}
    </p>
  );
}

function SubmitPanel({ place, onDone }: { place: PartnerPlace; onDone: () => void }) {
  const { t } = useT();
  const { api, reloadMe } = usePartner();
  const errorText = useErrorText();
  const [terms, setTerms] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [missing, setMissing] = useState<PartnerField[] | null>(null);
  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.submit(place.id, note);
      setMessage({ text: t("miniapp.partner.submit.sent"), alert: false });
      setMissing(null);
      reloadMe();
      onDone();
    } catch (err) {
      const fields = err instanceof ApiCallError ? err.details?.missingFields : undefined;
      if (Array.isArray(fields)) setMissing(fields as PartnerField[]);
      setMessage({ text: errorText(err, "miniapp.partner.submit.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={card} aria-labelledby="submit-title">
      <h2 id="submit-title">{t("miniapp.partner.submit.title")}</h2>
      <PlaceStatusInfo status={place.status} moderation={place.moderation} />
      <MissingFields fields={missing ?? place.missingFields} />
      <Live message={message} testId="submit-message" />
      {place.status === "pending_moderation" && <p>{t("miniapp.partner.submit.pending")}</p>}
      {SUBMITTABLE.has(place.status) &&
        (place.abilities.submit ? (
          <Stack>
            <label>
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />{" "}
              {t("miniapp.partner.submit.terms")}
            </label>
            <Field label={t("miniapp.partner.submit.note")}>
              {(id) => (
                <textarea
                  id={id}
                  value={note}
                  maxLength={1000}
                  rows={3}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <Button onClick={() => void submit()} disabled={busy || !terms || place.missingFields.length > 0}>
              {t("miniapp.partner.submit.button")}
            </Button>
          </Stack>
        ) : (
          <p>{t("miniapp.partner.submit.ownerOnly")}</p>
        ))}
    </section>
  );
}

function MainForm({ place, onSaved }: { place: PartnerPlace; onSaved: () => void }) {
  const { t, locale } = useT();
  const { api } = usePartner();
  const errorText = useErrorText();
  const [form, setForm] = useState(() => formOf(place));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const identity = place.abilities.editIdentity && place.status !== "published";
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    const patch = patchOf(place, form, identity);
    if (patch === "bad_location") {
      setMessage({ text: t("miniapp.partner.editor.badLocation"), alert: true });
      return;
    }
    if (!Object.keys(patch).length) {
      setMessage({ text: t("miniapp.partner.editor.noChanges"), alert: false });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.updatePlace(place.id, patch);
      setMessage({ text: t("miniapp.partner.editor.saved"), alert: false });
      onSaved();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.editor.saveError"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  const disabled = !place.editable;
  return (
    <section style={card} aria-labelledby="main-title">
      <h2 id="main-title">{t("miniapp.partner.editor.main")}</h2>
      {!identity && (
        <p data-testid="identity-locked">
          {t(
            place.abilities.editIdentity
              ? "miniapp.partner.editor.identityPublished"
              : "miniapp.partner.editor.identityRole",
          )}
        </p>
      )}
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
        <Stack>
          <Field label={t("miniapp.partner.field.name")}>
            {(id) => (
              <input id={id} value={form.name} maxLength={200} disabled={!identity} onChange={set("name")} />
            )}
          </Field>
          <Field label={t("miniapp.partner.field.category")}>
            {(id) => (
              <select id={id} value={form.categoryId} disabled={!identity} onChange={set("categoryId")}>
                {place.template.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {pickLocalized(c.name, locale)}
                  </option>
                ))}
                {!place.template.categories.some((c) => c.id === form.categoryId) && (
                  <option value={form.categoryId}>—</option>
                )}
              </select>
            )}
          </Field>
          <Field label={t("miniapp.partner.field.address")}>
            {(id) => (
              <input
                id={id}
                value={form.address}
                maxLength={200}
                disabled={!identity}
                onChange={set("address")}
              />
            )}
          </Field>
          <Field label={t("miniapp.partner.editor.lat")}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                value={form.lat}
                disabled={!identity}
                onChange={set("lat")}
              />
            )}
          </Field>
          <Field label={t("miniapp.partner.editor.lon")}>
            {(id) => (
              <input
                id={id}
                inputMode="decimal"
                value={form.lon}
                disabled={!identity}
                onChange={set("lon")}
              />
            )}
          </Field>
          <Field label={t("miniapp.partner.field.description")}>
            {(id) => (
              <textarea
                id={id}
                rows={4}
                maxLength={4000}
                value={form.description}
                onChange={set("description")}
              />
            )}
          </Field>
          <Field label={t("miniapp.partner.field.phone")}>
            {(id) => (
              <input id={id} type="tel" placeholder="+380…" value={form.phone} onChange={set("phone")} />
            )}
          </Field>
          <Field label={t("miniapp.partner.editor.website")}>
            {(id) => <input id={id} type="url" value={form.website} onChange={set("website")} />}
          </Field>
          <Field label={t("miniapp.partner.editor.telegram")}>
            {(id) => <input id={id} value={form.telegram} onChange={set("telegram")} />}
          </Field>
          <Live message={message} testId="editor-message" />
          <Button onClick={() => void save()} disabled={busy}>
            {t("miniapp.partner.editor.save")}
          </Button>
        </Stack>
      </fieldset>
    </section>
  );
}

type Row = { dayOfWeek: number; opensAt: string; closesAt: string };

export function scheduleOf(place: PartnerPlace, weekly: readonly Row[]): Schedule {
  return {
    weekly: weekly.map((r) => ({ dayOfWeek: r.dayOfWeek, opensAt: r.opensAt, closesAt: r.closesAt })),
    exceptions: place.schedule.exceptions.map((e) => ({
      date: e.date,
      closed: e.closed,
      ...(e.closed ? {} : { opensAt: e.opensAt, closesAt: e.closesAt }),
      ...(e.note ? { note: e.note } : {}),
    })),
  };
}

function ScheduleForm({ place, onSaved }: { place: PartnerPlace; onSaved: () => void }) {
  const { t } = useT();
  const { api } = usePartner();
  const errorText = useErrorText();
  const [rows, setRows] = useState<Row[]>(() => place.schedule.weekly.map((w) => ({ ...w })));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.putSchedule(place.id, scheduleOf(place, rows));
      setMessage({ text: t("miniapp.partner.schedule.saved"), alert: false });
      onSaved();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.editor.saveError"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={card} aria-labelledby="schedule-title">
      <h2 id="schedule-title">{t("miniapp.partner.field.schedule")}</h2>
      <fieldset disabled={!place.editable} style={{ border: 0, padding: 0, margin: 0 }}>
        {!rows.length && <p>{t("miniapp.partner.schedule.empty")}</p>}
        <ul style={listStyle} data-testid="schedule-rows">
          {rows.map((r, i) => (
            <li key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
              <Field label={t("miniapp.partner.schedule.day")}>
                {(id) => (
                  <select
                    id={id}
                    value={r.dayOfWeek}
                    onChange={(e) => update(i, { dayOfWeek: Number(e.target.value) })}
                  >
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <option key={d} value={d}>
                        {t(`admin.day.${d}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t("miniapp.partner.schedule.opens")}>
                {(id) => (
                  <input
                    id={id}
                    type="time"
                    value={r.opensAt}
                    onChange={(e) => update(i, { opensAt: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("miniapp.partner.schedule.closes")}>
                {(id) => (
                  <input
                    id={id}
                    type="time"
                    value={r.closesAt}
                    onChange={(e) => update(i, { closesAt: e.target.value })}
                  />
                )}
              </Field>
              <Button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                {t("miniapp.partner.schedule.remove")}
              </Button>
            </li>
          ))}
        </ul>
        <Stack>
          <Button
            onClick={() => setRows((rs) => [...rs, { dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }])}
          >
            {t("miniapp.partner.schedule.add")}
          </Button>
          <Live message={message} testId="schedule-message" />
          <Button onClick={() => void save()} disabled={busy}>
            {t("miniapp.partner.schedule.save")}
          </Button>
        </Stack>
      </fieldset>
    </section>
  );
}

function Photos({ place, onChanged }: { place: PartnerPlace; onChanged: () => void }) {
  const { t, locale } = useT();
  const { api } = usePartner();
  const errorText = useErrorText();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [inputKey, setInputKey] = useState(0);
  const upload = async () => {
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) {
      setMessage({ text: t("miniapp.partner.photos.badType"), alert: true });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.uploadPhoto(place.id, file, alt.trim());
      setMessage({ text: t("miniapp.partner.photos.uploaded"), alert: false });
      setFile(null);
      setAlt("");
      setInputKey((k) => k + 1);
      onChanged();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.photos.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (assetId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.deletePhoto(place.id, assetId);
      setMessage({ text: t("miniapp.partner.photos.deleted"), alert: false });
      onChanged();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.staff.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  const media = [...place.media].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <section style={card} aria-labelledby="photos-title">
      <h2 id="photos-title">{t("miniapp.partner.field.photo")}</h2>
      <fieldset disabled={!place.editable || busy} style={{ border: 0, padding: 0, margin: 0 }}>
        {!media.length && <p>{t("miniapp.partner.photos.empty")}</p>}
        <ul style={{ ...listStyle, flexDirection: "row", flexWrap: "wrap" }} data-testid="photos">
          {media.map((m, i) => {
            const url = place.mediaPreview[m.mediaAssetId];
            const label = m.alt
              ? pickLocalized(m.alt, locale)
              : `${t("miniapp.partner.field.photo")} ${i + 1}`;
            return (
              <li key={m.mediaAssetId} style={{ width: 160 }}>
                {url ? (
                  <img src={url} alt={label} width={160} style={{ borderRadius: 12, display: "block" }} />
                ) : (
                  <p>{t("miniapp.partner.photos.processing")}</p>
                )}
                {m.isCover && <small>{t("miniapp.partner.photos.cover")}</small>}
                <Button
                  aria-label={`${t("miniapp.partner.photos.delete")}: ${label}`}
                  onClick={() => void remove(m.mediaAssetId)}
                >
                  {t("miniapp.partner.photos.delete")}
                </Button>
              </li>
            );
          })}
        </ul>
        <Stack>
          <Field label={t("miniapp.partner.photos.alt")}>
            {(id) => <input id={id} value={alt} maxLength={200} onChange={(e) => setAlt(e.target.value)} />}
          </Field>
          <Field label={t("miniapp.partner.photos.file")}>
            {(id) => (
              <input
                key={inputKey}
                id={id}
                type="file"
                accept={PHOTO_TYPES.join(",")}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
          </Field>
          <Live message={message} testId="photos-message" />
          <Button onClick={() => void upload()} disabled={!file}>
            {t("miniapp.partner.photos.upload")}
          </Button>
        </Stack>
      </fieldset>
    </section>
  );
}

export function PlaceEditor({ id }: { id: string }) {
  const { t, locale } = useT();
  const { api, enabled } = usePartner();
  const [state, reload] = useLiveAsync(
    () => (enabled ? api.place(id) : Promise.reject(new NotFoundError())),
    [api, id, enabled],
  );
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  if (state.status === "loading")
    return (
      <p role="status" className="kosiv-muted">
        {t("miniapp.guide.loading")}
      </p>
    );
  if (state.status === "error")
    return (
      <Stack>
        <h1>{t("miniapp.partner.editPlace")}</h1>
        <p role="alert" data-testid="editor-error">
          {state.error instanceof NotFoundError ||
          (state.error instanceof ApiCallError && state.error.status === 403)
            ? t("miniapp.partner.notFound")
            : t("miniapp.partner.loadError")}
        </p>
        {!(state.error instanceof NotFoundError) && (
          <Button onClick={reload}>{t("miniapp.guide.retry")}</Button>
        )}
        <Link to="/partner">{t("miniapp.partner.toDashboard")}</Link>
      </Stack>
    );
  const place = state.data;
  return (
    <Stack>
      <h1>{pickLocalized(place.name, locale)}</h1>
      <Link to="/partner">{t("miniapp.partner.toDashboard")}</Link>
      <SubmitPanel place={place} onDone={reload} />
      {!place.abilities.editPlace ? (
        <p role="alert">{t("miniapp.partner.editor.forbidden")}</p>
      ) : (
        <>
          {!place.editable && <p data-testid="editor-readonly">{t("miniapp.partner.editor.readonly")}</p>}
          {/* key — форма заново из ответа после сохранения (updatedAt) */}
          <MainForm key={`main-${place.updatedAt}`} place={place} onSaved={reload} />
          <ScheduleForm key={`schedule-${place.updatedAt}`} place={place} onSaved={reload} />
          <Photos place={place} onChanged={reload} />
        </>
      )}
    </Stack>
  );
}
