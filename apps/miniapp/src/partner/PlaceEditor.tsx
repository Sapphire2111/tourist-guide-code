// P06 редактор заведения: секции-аккордеон (#basic, #photos, #schedule, #extra), одна липкая панель «Зберегти» /
// «Надіслати на перевірку», модерация внизу. Права — abilities/editable из ответа API: менеджер не правит поля
// личности, у опубликованного они заблокированы (409 identityChangeRequiresModeration — через админа региона).
// «Зберегти» шлёт все изменённые поля всех секций одним PATCH и, если менялся график, PUT /schedule.
// Раздел открывается по ?section=basic|photos|schedule|extra в адресе (ссылки с дашборда).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, useT } from "@tg/ui";
import { NotFoundError } from "../guide/types.js";
import { useErrorText } from "../host/errors.js";
import { ApiCallError } from "../host/types.js";
import { useKeptAsync, usePartner } from "./context.js";
import { LocationPicker } from "./LocationPicker.js";
import type { PartnerField, PartnerPlace, PlacePatch, Schedule } from "./partner-api.js";
import { fieldKey, Live, PartnerHeader, PlaceStatusCard, type Message } from "./parts.js";
import { Photos } from "./Photos.js";
import { sameSchedule, ScheduleForm, type Row } from "./ScheduleForm.js";
import { SECTIONS, sectionOf, type SectionId } from "./sections.js";

const SUBMITTABLE = new Set(["draft", "changes_requested", "rejected"]);

export { SECTIONS, sectionOf, type SectionId } from "./sections.js";

/** Порядок в подсказке «Ще потрібно». */
const FIELD_ORDER: PartnerField[] = [
  "name",
  "category",
  "address",
  "location",
  "phone",
  "description",
  "schedule",
  "photo",
];

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
 * "empty_name" — название стёрто (обязательно); "bad_location" — координаты заданы не обе или не числами.
 */
export function patchOf(
  place: PartnerPlace,
  form: Form,
  identity: boolean,
): PlacePatch | "bad_location" | "empty_name" {
  const before = formOf(place);
  const patch: PlacePatch = {};
  const changed = (k: keyof Form) => form[k].trim() !== before[k].trim();
  if (identity) {
    if (!form.name.trim()) return "empty_name";
    if (changed("name")) patch.name = { uk: form.name.trim() };
    if (changed("categoryId") && form.categoryId) patch.categoryId = form.categoryId;
    if (changed("address")) patch.address = text(form.address);
    if (changed("lat") || changed("lon")) {
      if (!form.lat.trim() && !form.lon.trim()) patch.location = null;
      else {
        const lat = Number(form.lat.replace(",", "."));
        const lon = Number(form.lon.replace(",", "."));
        if (!form.lat.trim() || !form.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon))
          return "bad_location";
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return "bad_location";
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

/** Что ещё нужно для отправки: обязательные поля шаблона и пустые на сервере, с учётом ещё не сохранённых правок. */
export function neededFields(place: PartnerPlace, form: Form, rows: readonly Row[]): PartnerField[] {
  const candidates = new Set<PartnerField>([...place.missingFields, ...place.template.requiredFields]);
  const filled = (f: PartnerField): boolean => {
    switch (f) {
      case "name":
        return !!form.name.trim();
      case "category":
        return !!form.categoryId;
      case "description":
        return !!form.description.trim();
      case "address":
        return !!form.address.trim();
      case "phone":
        return !!form.phone.trim();
      case "location": {
        const lat = Number(form.lat.replace(",", "."));
        const lon = Number(form.lon.replace(",", "."));
        return (
          !!form.lat.trim() &&
          !!form.lon.trim() &&
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180
        );
      }
      case "schedule":
        return rows.length > 0;
      default:
        // Фото загружаются сразу: правда — на сервере.
        return !place.missingFields.includes(f);
    }
  };
  return FIELD_ORDER.filter((f) => candidates.has(f) && !filled(f));
}

function sectionFromHash(): SectionId | null {
  const q = window.location.hash.split("?")[1];
  const s = new URLSearchParams(q ?? "").get("section");
  return (SECTIONS as readonly string[]).includes(s ?? "") ? (s as SectionId) : null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="partner-field">
      <label htmlFor={id}>{label}</label>
      {children(id, hint ? hintId : undefined)}
      {hint && (
        <span id={hintId} className="partner-field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  open,
  needed,
  onToggle,
  children,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  needed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const body = useId();
  return (
    <section id={id} className="partner-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        <button
          type="button"
          id={`${id}-toggle`}
          className="partner-section-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={onToggle}
        >
          <span>{title}</span>
          {needed && (
            <span className="kosiv-chip" data-tone="accent2">
              {t("miniapp.partner.editor.sectionNeeded")}
            </span>
          )}
          <span aria-hidden="true" className="partner-section-caret" data-open={open || undefined}>
            ▾
          </span>
        </button>
      </h2>
      <div id={body} hidden={!open} className="partner-section-body">
        {children}
      </div>
    </section>
  );
}

function EditorBody({
  place,
  reload,
  refreshError,
}: {
  place: PartnerPlace;
  reload: () => void;
  refreshError: unknown;
}) {
  const { t, locale } = useT();
  const { api, reloadMe } = usePartner();
  const errorText = useErrorText();
  const [form, setForm] = useState(() => formOf(place));
  const [rows, setRows] = useState<Row[]>(() => place.schedule.weekly.map((w) => ({ ...w })));
  const [terms, setTerms] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [submitMessage, setSubmitMessage] = useState<Message>(null);
  const [serverMissing, setServerMissing] = useState<PartnerField[] | null>(null);
  const termsRef = useRef<HTMLInputElement>(null);
  const target = useRef(sectionFromHash());

  // Список от сервера (422) устаревает, как только место перечитано (загрузили фото, сохранили): считаем заново.
  const missingKey = place.missingFields.join();
  useEffect(() => {
    setServerMissing(null);
  }, [place.updatedAt, missingKey]);

  const identity = place.abilities.editIdentity && place.status !== "published";
  const locked = !place.editable || busy;
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const needed = neededFields(place, form, rows);
  const neededIn = (s: SectionId) => needed.some((f) => sectionOf(f) === s);
  const [open, setOpen] = useState<Record<SectionId, boolean>>(() => ({
    basic: true,
    photos: !place.editable || neededIn("photos") || target.current === "photos",
    schedule: !place.editable || neededIn("schedule") || target.current === "schedule",
    extra: !place.editable || neededIn("extra") || target.current === "extra",
  }));

  const reveal = (s: SectionId) => {
    setOpen((o) => ({ ...o, [s]: true }));
    requestAnimationFrame(() => {
      const el = document.getElementById(s);
      el?.scrollIntoView?.({ block: "start" });
      document.getElementById(`${s}-toggle`)?.focus({ preventScroll: true });
    });
  };
  // Ссылка с дашборда: ?section=… — открыть и показать раздел при загрузке и при смене адреса.
  useEffect(() => {
    if (target.current) reveal(target.current);
    const onHash = () => {
      const s = sectionFromHash();
      if (s) reveal(s);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const patch = patchOf(place, form, identity);
  const scheduleDirty = !sameSchedule(rows, place.schedule.weekly);
  const dirty = typeof patch === "string" || Object.keys(patch).length > 0 || scheduleDirty;
  // Закрытие вкладки с несохранёнными правками: браузерное предупреждение.
  useEffect(() => {
    if (!dirty || !place.editable) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, place.editable]);

  /** Одно сохранение всех секций: PATCH изменённых полей, затем PUT графика, если менялся. */
  const save = async (): Promise<boolean> => {
    if (patch === "empty_name") {
      setMessage({ text: t("miniapp.partner.editor.nameRequired"), alert: true });
      reveal("basic");
      return false;
    }
    if (patch === "bad_location") {
      setMessage({ text: t("miniapp.partner.editor.badLocation"), alert: true });
      reveal("extra");
      return false;
    }
    const hasPatch = Object.keys(patch).length > 0;
    if (!hasPatch && !scheduleDirty) {
      setMessage({ text: t("miniapp.partner.editor.noChanges"), alert: false });
      return true;
    }
    setBusy(true);
    setMessage(null);
    let changed = false;
    try {
      if (hasPatch) {
        // Форма — из ответа сервера (нормализованные значения), иначе «@name» вечно считался бы правкой.
        setForm(formOf(await api.updatePlace(place.id, patch)));
        changed = true;
      }
      if (scheduleDirty) {
        await api.putSchedule(place.id, scheduleOf(place, rows));
        changed = true;
      }
      setServerMissing(null);
      setMessage({ text: t("miniapp.partner.editor.saved"), alert: false });
      return true;
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.editor.saveError"), alert: true });
      return false;
    } finally {
      setBusy(false);
      if (changed) reload();
    }
  };

  const submit = async () => {
    if (!terms) {
      setSubmitMessage({ text: t("miniapp.partner.editor.termsRequired"), alert: true });
      termsRef.current?.focus();
      return;
    }
    setSubmitMessage(null);
    // Несохранённые правки уходят вместе с отправкой: сначала сохраняем.
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await api.submit(place.id, note);
      setSubmitMessage({ text: t("miniapp.partner.submit.sent"), alert: false });
      setServerMissing(null);
      reloadMe();
      reload();
    } catch (err) {
      const fields = err instanceof ApiCallError ? err.details?.missingFields : undefined;
      if (Array.isArray(fields)) setServerMissing(fields as PartnerField[]);
      setSubmitMessage({ text: errorText(err, "miniapp.partner.submit.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };

  const missing = serverMissing ?? needed;
  const canSubmit = SUBMITTABLE.has(place.status) && place.abilities.submit;
  const toggle = (s: SectionId) => () => setOpen((o) => ({ ...o, [s]: !o[s] }));
  const identityNote = !identity && (
    <p data-testid="identity-locked">
      {t(
        place.abilities.editIdentity
          ? "miniapp.partner.editor.identityPublished"
          : "miniapp.partner.editor.identityRole",
      )}
    </p>
  );

  return (
    <div className="partner-screen">
      <PartnerHeader title={pickLocalized(place.name, locale)} />
      <PlaceStatusCard status={place.status} moderation={place.moderation} />
      {refreshError !== null && (
        <p role="alert" data-testid="editor-refresh-error">
          {t("miniapp.partner.refreshError")}
        </p>
      )}
      {!place.abilities.editPlace ? (
        <p role="alert">{t("miniapp.partner.editor.forbidden")}</p>
      ) : (
        <>
          {!place.editable && <p data-testid="editor-readonly">{t("miniapp.partner.editor.readonly")}</p>}
          {/* После отправки правка закрыта и панели нет: итог отправки остаётся на экране. */}
          {!place.editable && <Live message={submitMessage} testId="submit-message" />}
          <Section
            id="basic"
            title={t("miniapp.partner.editor.section.basic")}
            open={open.basic}
            needed={neededIn("basic")}
            onToggle={toggle("basic")}
          >
            {identityNote}
            <fieldset disabled={locked} className="partner-fieldset">
              <Field label={t("miniapp.partner.field.name")}>
                {(id) => (
                  <input
                    id={id}
                    value={form.name}
                    maxLength={200}
                    disabled={!identity}
                    onChange={set("name")}
                  />
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
            </fieldset>
          </Section>

          <Section
            id="photos"
            title={t("miniapp.partner.editor.section.photos")}
            open={open.photos}
            needed={neededIn("photos")}
            onToggle={toggle("photos")}
          >
            <Photos place={place} onChanged={reload} />
          </Section>

          <Section
            id="schedule"
            title={t("miniapp.partner.editor.section.schedule")}
            open={open.schedule}
            needed={neededIn("schedule")}
            onToggle={toggle("schedule")}
          >
            <ScheduleForm rows={rows} onChange={setRows} disabled={locked} />
          </Section>

          <Section
            id="extra"
            title={t("miniapp.partner.editor.section.extra")}
            open={open.extra}
            needed={neededIn("extra")}
            onToggle={toggle("extra")}
          >
            <fieldset disabled={locked} className="partner-fieldset">
              <Field
                label={t("miniapp.partner.editor.fieldWebsite")}
                hint={t("miniapp.partner.editor.websiteHint")}
              >
                {(id, d) => (
                  <input
                    id={id}
                    type="url"
                    inputMode="url"
                    placeholder="https://…"
                    aria-describedby={d}
                    value={form.website}
                    onChange={set("website")}
                  />
                )}
              </Field>
              <Field
                label={t("miniapp.partner.editor.telegram")}
                hint={t("miniapp.partner.editor.telegramHint")}
              >
                {(id, d) => (
                  <input id={id} aria-describedby={d} value={form.telegram} onChange={set("telegram")} />
                )}
              </Field>
              {!identity && <p>{t("miniapp.partner.editor.identityLockedHere")}</p>}
              <LocationPicker
                lat={form.lat}
                lon={form.lon}
                disabled={!identity}
                onChange={(lat, lon) => setForm((f) => ({ ...f, lat, lon }))}
              />
            </fieldset>
          </Section>

          {(place.status === "pending_moderation" || SUBMITTABLE.has(place.status)) && (
            <section id="moderation" className="partner-section" aria-labelledby="submit-title">
              <h2 id="submit-title">{t("miniapp.partner.submit.title")}</h2>
              <div className="partner-section-body">
                {place.status === "pending_moderation" && <p>{t("miniapp.partner.submit.pending")}</p>}
                {SUBMITTABLE.has(place.status) &&
                  (place.abilities.submit ? (
                    <>
                      <label className="partner-check">
                        <input
                          ref={termsRef}
                          type="checkbox"
                          checked={terms}
                          onChange={(e) => setTerms(e.target.checked)}
                        />
                        {t("miniapp.partner.submit.terms")}
                      </label>
                      <details className="partner-details">
                        <summary>{t("miniapp.partner.submit.addNote")}</summary>
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
                      </details>
                    </>
                  ) : (
                    <p>{t("miniapp.partner.submit.ownerOnly")}</p>
                  ))}
              </div>
            </section>
          )}

          {place.editable && (
            <div className="partner-sticky-actions" data-testid="editor-actions">
              <div className="partner-sticky-note">
                <Live message={message} testId="editor-message" />
                <Live message={submitMessage} testId="submit-message" />
                {dirty && (
                  <p className="partner-unsaved" data-testid="editor-unsaved">
                    {t("miniapp.partner.editor.unsaved")}
                  </p>
                )}
                {canSubmit && (
                  <div data-testid="missing-fields" className="partner-needed">
                    {missing.length ? (
                      <>
                        <span>{t("miniapp.partner.editor.stillNeeded")}</span>
                        {missing.map((f) => (
                          <button
                            key={f}
                            type="button"
                            className="partner-chip"
                            onClick={() => reveal(sectionOf(f))}
                          >
                            {t(fieldKey(f))}
                          </button>
                        ))}
                      </>
                    ) : (
                      <span>{t("miniapp.partner.editor.complete")}</span>
                    )}
                  </div>
                )}
              </div>
              <Button onClick={() => void save()} disabled={busy || !dirty}>
                {t("miniapp.partner.editor.save")}
              </Button>
              {canSubmit && (
                <Button onClick={() => void submit()} disabled={busy || missing.length > 0}>
                  {t("miniapp.partner.submit.button")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function PlaceEditor({ id }: { id: string }) {
  const { t } = useT();
  const { api, enabled } = usePartner();
  const [state, reload, refreshError] = useKeptAsync(
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
      <div className="partner-screen">
        <PartnerHeader title={t("miniapp.partner.editPlace")} />
        <p role="alert" data-testid="editor-error">
          {state.error instanceof NotFoundError ||
          (state.error instanceof ApiCallError && state.error.status === 403)
            ? t("miniapp.partner.notFound")
            : t("miniapp.partner.loadError")}
        </p>
        {!(state.error instanceof NotFoundError) && (
          <Button onClick={reload}>{t("miniapp.guide.retry")}</Button>
        )}
      </div>
    );
  // Без key: формы не перемонтируются после чужого сохранения (несохранённые правки остаются).
  return <EditorBody place={state.data} reload={reload} refreshError={refreshError} />;
}
