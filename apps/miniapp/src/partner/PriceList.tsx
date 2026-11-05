// «Прайс» заведения (миграция 0030): один экран — разделы сворачиваемыми группами, «+ Позиція» в каждом разделе,
// тап по позиции — небольшой лист правки (название, цена, «від», единица, описание, скрыть, раздел, архив). Порядок —
// кнопками ▲▼ (без перетаскивания). Пустой прайс — пример того, как он выглядит в карточке, и быстрый старт
// типовыми разделами. Права — abilities.managePriceList (ORG_OWNER, ORG_MANAGER); сервер проверяет сам.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { createTranslator, loadLocale, pickLocalized, type LocalizedText, type MessageKey } from "@tg/i18n";
import { Stack, useT } from "@tg/ui";
import { AsyncView } from "../guide/parts.js";
import { useSheet } from "../guide/use-sheet.js";
import { useErrorText } from "../host/errors.js";
import { ConflictError } from "../host/types.js";
import { parsePrice, priceInput, priceText } from "../price-list/price.js";
import "../price-list/price-list.css";
import { orgOfPlace, useKeptAsync, usePartner, usePartnerOrgs } from "./context.js";
import type { MoveDirection, PriceItem, PriceList, PriceSection } from "./partner-api.js";
import { EmptyState, Live, PartnerHeader, type Message } from "./parts.js";

/** Типовые разделы быстрого старта (пустой прайс). */
const SUGGESTED: readonly MessageKey[] = [
  "miniapp.partner.prices.suggest.food",
  "miniapp.partner.prices.suggest.drinks",
  "miniapp.partner.prices.suggest.chany",
  "miniapp.partner.prices.suggest.rooms",
  "miniapp.partner.prices.suggest.services",
];
const UNITS: readonly MessageKey[] = [
  "miniapp.partner.prices.unit.hour",
  "miniapp.partner.prices.unit.person",
  "miniapp.partner.prices.unit.portion",
  "miniapp.partner.prices.unit.night",
];

/** Название типового раздела хранится на uk и en, какой бы ни был язык интерфейса партнёра. */
const UK = createTranslator("uk");
const EN = createTranslator("en");
/** Название подсказанного раздела на uk и en; en-словарь грузится лениво — не загрузился, шлём только uk. */
export async function suggestedTitle(key: MessageKey): Promise<LocalizedText> {
  try {
    await loadLocale("en");
  } catch {
    return { uk: UK.t(key) };
  }
  return { uk: UK.t(key), en: EN.t(key) };
}

type Sheet = { sectionId: string; item: PriceItem | null } | null;
type Run = (action: () => Promise<PriceList>, done?: MessageKey) => Promise<boolean>;

export function PartnerPriceList({ placeId }: { placeId: string }) {
  const { t } = useT();
  const { api, enabled } = usePartner();
  const org = orgOfPlace(usePartnerOrgs(), placeId);
  const errorText = useErrorText();
  const [loaded, reload, refreshError] = useKeptAsync(
    () => (enabled ? api.priceList(placeId) : Promise.reject(new Error("disabled"))),
    [api, placeId, enabled],
  );
  const loadedData = loaded.status === "ready" ? loaded.data : null;
  const loadedRef = useRef(loadedData);
  loadedRef.current = loadedData;
  // Ответ изменения — прайс целиком. Действует, пока загруженные данные те же, от которых он получен: новое чтение
  // с сервера (повтор, перечитывание после конфликта) его вытесняет.
  const [fresh, setFresh] = useState<{ base: PriceList | null; list: PriceList } | null>(null);
  const current = fresh && fresh.base === loadedData ? fresh.list : loadedData;
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);

  const run: Run = useCallback(
    async (action, done) => {
      setBusy(true);
      setMessage(null);
      try {
        const list = await action();
        setFresh({ base: loadedRef.current, list });
        if (done) setMessage({ text: t(done), alert: false });
        return true;
      } catch (err) {
        // Версия разошлась (правили с другого устройства): лист со старой версией закрываем — иначе каждое
        // сохранение снова 409; прайс перечитываем, партнёр проверяет и сохраняет ещё раз.
        if (err instanceof ConflictError) {
          setSheet(null);
          setFresh(null);
          setMessage({ text: t("miniapp.partner.prices.conflict"), alert: true });
          reload();
        } else setMessage({ text: errorText(err, "miniapp.partner.prices.error"), alert: true });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t, errorText, reload],
  );

  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  const forbidden = org !== null && !org.abilities.managePriceList;
  return (
    <Stack>
      <PartnerHeader title={t("miniapp.partner.prices.title")} />
      {forbidden ? (
        <p role="alert">{t("miniapp.partner.prices.forbidden")}</p>
      ) : (
        <>
          <p className="pl-hint">{t("miniapp.partner.prices.intro")}</p>
          <Live message={sheet ? null : message} testId="prices-message" />
          {refreshError !== null && <p role="alert">{t("miniapp.partner.refreshError")}</p>}
          <AsyncView
            state={loaded}
            retry={reload}
            errorText={errorText(
              loaded.status === "error" ? loaded.error : null,
              "miniapp.partner.loadError",
            )}
          >
            {(data) => {
              const list = current ?? data;
              return (
                <Editor
                  placeId={placeId}
                  list={list}
                  busy={busy}
                  run={run}
                  openSheet={(sectionId, item) => {
                    setMessage(null);
                    setSheet({ sectionId, item });
                  }}
                />
              );
            }}
          </AsyncView>
          {sheet && current && (
            <ItemSheet
              placeId={placeId}
              sheet={sheet}
              sections={current.sections}
              busy={busy}
              message={message}
              run={run}
              onClose={() => setSheet(null)}
            />
          )}
        </>
      )}
    </Stack>
  );
}

function Editor({
  placeId,
  list,
  busy,
  run,
  openSheet,
}: {
  placeId: string;
  list: PriceList;
  busy: boolean;
  run: Run;
  openSheet: (sectionId: string, item: PriceItem | null) => void;
}) {
  const { t } = useT();
  const { api } = usePartner();
  const [title, setTitle] = useState("");
  const titleId = useId();
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    if (
      await run(() => api.createPriceSection(placeId, { uk: name }), "miniapp.partner.prices.sectionCreated")
    )
      setTitle("");
  };
  const atLimit = list.itemCount >= list.limits.maxItems;
  return (
    <>
      {list.sections.length === 0 ? (
        <EmptyState
          text={t("miniapp.partner.prices.empty")}
          icon="🧾"
          testId="prices-empty"
          action={
            <div className="pl-empty-extra">
              <p className="pl-hint">{t("miniapp.partner.prices.exampleTitle")}</p>
              <div className="pl-example" aria-hidden="true">
                <div className="pl-card-section">
                  <span className="pl-card-title">{t("miniapp.partner.prices.exampleSection")}</span>
                  <ul className="pl-card-list">
                    <li className="pl-card-row">
                      <span className="pl-card-name">{t("miniapp.partner.prices.exampleItem1")}</span>
                      <span className="pl-card-price">{t("miniapp.partner.prices.exampleItem1Price")}</span>
                    </li>
                    <li className="pl-card-row">
                      <span className="pl-card-name">{t("miniapp.partner.prices.exampleItem2")}</span>
                      <span className="pl-card-price">{t("miniapp.partner.prices.exampleItem2Price")}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p className="pl-hint">{t("miniapp.partner.prices.quickStart")}</p>
              <div className="pl-chips">
                {SUGGESTED.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="pl-chip"
                    disabled={busy}
                    aria-label={t("miniapp.partner.prices.addSuggested", { title: t(key) })}
                    onClick={() =>
                      void run(
                        async () => api.createPriceSection(placeId, await suggestedTitle(key)),
                        "miniapp.partner.prices.sectionCreated",
                      )
                    }
                  >
                    + {t(key)}
                  </button>
                ))}
              </div>
            </div>
          }
        />
      ) : (
        <ul className="partner-list" data-testid="prices-sections">
          {list.sections.map((s, i) => (
            <SectionGroup
              key={s.id}
              placeId={placeId}
              section={s}
              first={i === 0}
              last={i === list.sections.length - 1}
              busy={busy}
              atLimit={atLimit}
              run={run}
              openSheet={openSheet}
            />
          ))}
        </ul>
      )}
      {list.itemCount > 0 && (
        <p className="pl-hint" data-testid="prices-limit">
          {t("miniapp.partner.prices.limit", { count: list.itemCount, max: list.limits.maxItems })}
        </p>
      )}
      {list.sections.length < list.limits.maxSections && (
        <form className="pl-add" onSubmit={(e) => void add(e)}>
          <label htmlFor={titleId} className="partner-field">
            {t("miniapp.partner.prices.sectionName")}
            <input id={titleId} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button type="submit" className="pl-btn" disabled={busy || !title.trim()}>
            {t("miniapp.partner.prices.addSection")}
          </button>
        </form>
      )}
    </>
  );
}

function SectionGroup({
  placeId,
  section: s,
  first,
  last,
  busy,
  atLimit,
  run,
  openSheet,
}: {
  placeId: string;
  section: PriceSection;
  first: boolean;
  last: boolean;
  busy: boolean;
  atLimit: boolean;
  run: Run;
  openSheet: (sectionId: string, item: PriceItem | null) => void;
}) {
  const { t, locale } = useT();
  const { api } = usePartner();
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const bodyId = useId();
  const renameId = useId();
  const renameRef = useRef<HTMLInputElement>(null);
  const isRenaming = renaming !== null;
  // Кнопка «Перейменувати» исчезает — фокус в поле нового названия.
  useEffect(() => {
    if (isRenaming) renameRef.current?.focus();
  }, [isRenaming]);
  const title = pickLocalized(s.title, locale);
  const move = (direction: MoveDirection) => () =>
    void run(() => api.movePriceSection(placeId, s.id, direction));
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const uk = renaming?.trim();
    if (!uk) return;
    const ok = await run(
      () => api.updatePriceSection(placeId, s.id, { title: { ...s.title, uk }, version: s.version }),
      "miniapp.partner.prices.saved",
    );
    if (ok) setRenaming(null);
  };
  return (
    <li className="pl-section" data-hidden={s.hidden || undefined} data-testid="price-section">
      <div className="pl-section-head">
        <h2 className="pl-heading">
          <button
            type="button"
            className="pl-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((x) => !x)}
          >
            <span className="pl-caret" aria-hidden="true">
              ▸
            </span>
            <span className="pl-title">{title}</span>
            {s.hidden && <span className="pl-badge">{t("miniapp.partner.prices.hiddenBadge")}</span>}
            <span className="pl-count">
              {t("miniapp.partner.prices.itemsCount", { count: s.items.length })}
            </span>
          </button>
        </h2>
        <button
          type="button"
          className="pl-icon"
          disabled={busy || first}
          aria-label={t("miniapp.partner.prices.sectionUp", { title })}
          onClick={move("up")}
        >
          ▲
        </button>
        <button
          type="button"
          className="pl-icon"
          disabled={busy || last}
          aria-label={t("miniapp.partner.prices.sectionDown", { title })}
          onClick={move("down")}
        >
          ▼
        </button>
      </div>
      {open && (
        <div id={bodyId} className="pl-section-body">
          {s.items.length === 0 ? (
            <p className="pl-hint">{t("miniapp.partner.prices.sectionEmpty")}</p>
          ) : (
            <ul className="pl-items">
              {s.items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  placeId={placeId}
                  item={item}
                  first={i === 0}
                  last={i === s.items.length - 1}
                  busy={busy}
                  run={run}
                  onOpen={() => openSheet(s.id, item)}
                />
              ))}
            </ul>
          )}
          <div className="pl-tools">
            <button
              type="button"
              className="pl-btn"
              data-variant="primary"
              disabled={busy || atLimit}
              aria-haspopup="dialog"
              aria-label={t("miniapp.partner.prices.addItemTo", { section: title })}
              onClick={() => openSheet(s.id, null)}
            >
              {t("miniapp.partner.prices.addItem")}
            </button>
            <button
              type="button"
              className="pl-btn"
              disabled={busy}
              aria-pressed={s.hidden}
              aria-label={t(
                s.hidden ? "miniapp.partner.prices.showSection" : "miniapp.partner.prices.hideSection",
                { title },
              )}
              onClick={() =>
                void run(
                  () => api.updatePriceSection(placeId, s.id, { hidden: !s.hidden, version: s.version }),
                  "miniapp.partner.prices.saved",
                )
              }
            >
              {t(s.hidden ? "miniapp.partner.prices.show" : "miniapp.partner.prices.hide")}
            </button>
            {renaming === null && (
              <button
                type="button"
                className="pl-btn"
                disabled={busy}
                aria-label={t("miniapp.partner.prices.renameSection", { title })}
                onClick={() => setRenaming(s.title.uk)}
              >
                {t("miniapp.partner.prices.rename")}
              </button>
            )}
            {confirm ? (
              <>
                <button
                  type="button"
                  className="pl-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.archivePriceSection(placeId, s.id), "miniapp.partner.prices.archived")
                  }
                >
                  {t("miniapp.partner.prices.archiveSectionConfirm")}
                </button>
                <button type="button" className="pl-btn" disabled={busy} onClick={() => setConfirm(false)}>
                  {t("miniapp.partner.prices.cancel")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="pl-btn"
                disabled={busy}
                aria-label={t("miniapp.partner.prices.archiveSection", { title })}
                onClick={() => setConfirm(true)}
              >
                {t("miniapp.partner.prices.archive")}
              </button>
            )}
          </div>
          {renaming !== null && (
            <form className="pl-add" onSubmit={(e) => void rename(e)}>
              <label htmlFor={renameId} className="partner-field">
                {t("miniapp.partner.prices.newTitle")}
                <input
                  id={renameId}
                  ref={renameRef}
                  value={renaming}
                  maxLength={80}
                  onChange={(e) => setRenaming(e.target.value)}
                />
              </label>
              <button type="submit" className="pl-btn" disabled={busy || !renaming.trim()}>
                {t("miniapp.partner.prices.save")}
              </button>
              <button type="button" className="pl-btn" onClick={() => setRenaming(null)}>
                {t("miniapp.partner.prices.cancel")}
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

function ItemRow({
  placeId,
  item,
  first,
  last,
  busy,
  run,
  onOpen,
}: {
  placeId: string;
  item: PriceItem;
  first: boolean;
  last: boolean;
  busy: boolean;
  run: Run;
  onOpen: () => void;
}) {
  const { t, locale } = useT();
  const { api } = usePartner();
  const name = pickLocalized(item.name, locale);
  const unit = item.unit ? pickLocalized(item.unit, locale) : null;
  const move = (direction: MoveDirection) => () =>
    void run(() => api.movePriceItem(placeId, item.id, direction));
  return (
    <li className="pl-item" data-hidden={item.hidden || undefined} data-testid="price-item">
      <button type="button" className="pl-row" aria-haspopup="dialog" onClick={onOpen}>
        <span className="pl-row-name">
          <strong>{name}</strong>
          {item.hidden && <span className="pl-badge">{t("miniapp.partner.prices.hiddenBadge")}</span>}
        </span>
        <span className="pl-row-price">{priceText(t, locale, item, unit)}</span>
      </button>
      <button
        type="button"
        className="pl-icon"
        disabled={busy || first}
        aria-label={t("miniapp.partner.prices.itemUp", { name })}
        onClick={move("up")}
      >
        ▲
      </button>
      <button
        type="button"
        className="pl-icon"
        disabled={busy || last}
        aria-label={t("miniapp.partner.prices.itemDown", { name })}
        onClick={move("down")}
      >
        ▼
      </button>
    </li>
  );
}

/** Текст поля → мультиязычное значение: uk из поля, прочие переводы сохраняются; пусто — null. */
function textOf(
  value: string,
  previous: { uk: string; en?: string } | null,
): { uk: string; en?: string } | null {
  const uk = value.trim();
  return uk ? { ...(previous ?? {}), uk } : null;
}

function ItemSheet({
  placeId,
  sheet,
  sections,
  busy,
  message,
  run,
  onClose,
}: {
  placeId: string;
  sheet: NonNullable<Sheet>;
  sections: PriceSection[];
  busy: boolean;
  message: Message;
  run: Run;
  onClose: () => void;
}) {
  const { t } = useT();
  const { api } = usePartner();
  const editing = sheet.item;
  const [name, setName] = useState(editing?.name.uk ?? "");
  const [price, setPrice] = useState(editing ? priceInput(editing.priceMinor) : "");
  const [from, setFrom] = useState(editing?.priceFrom ?? false);
  const [unit, setUnit] = useState(editing?.unit?.uk ?? "");
  const [description, setDescription] = useState(editing?.description?.uk ?? "");
  const [hidden, setHidden] = useState(editing?.hidden ?? false);
  const [sectionId, setSectionId] = useState(sheet.sectionId);
  const [confirm, setConfirm] = useState(false);
  const [local, setLocal] = useState<Message>(null);
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  useSheet(ref, close);
  // useSheet ставит фокус на отмеченный чекбокс («від», «Приховати»); в листе позиции начинаем с названия.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const ids = { title: useId(), name: useId(), price: useId(), unit: useId(), units: useId(), desc: useId() };
  const sectionField = useId();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const uk = name.trim();
    if (!uk) return setLocal({ text: t("miniapp.partner.prices.needName"), alert: true });
    const priceMinor = parsePrice(price);
    if (priceMinor === null) return setLocal({ text: t("miniapp.partner.prices.badPrice"), alert: true });
    setLocal(null);
    const fields = {
      name: { ...(editing?.name ?? {}), uk },
      priceMinor,
      priceFrom: from,
      unit: textOf(unit, editing?.unit ?? null),
      description: textOf(description, editing?.description ?? null),
    };
    const ok = editing
      ? await run(
          () =>
            api.updatePriceItem(placeId, editing.id, {
              ...fields,
              hidden,
              ...(sectionId !== editing.sectionId ? { sectionId } : {}),
              version: editing.version,
            }),
          "miniapp.partner.prices.saved",
        )
      : await run(
          () => api.createPriceItem(placeId, { ...fields, sectionId }),
          "miniapp.partner.prices.itemCreated",
        );
    if (ok) onClose();
  };
  const archive = async () => {
    if (!editing) return;
    if (await run(() => api.archivePriceItem(placeId, editing.id), "miniapp.partner.prices.archived"))
      onClose();
  };

  return createPortal(
    <div className="pl-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="pl-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        data-testid="price-item-sheet"
      >
        <h2 id={ids.title}>
          {t(editing ? "miniapp.partner.prices.editItem" : "miniapp.partner.prices.newItem")}
        </h2>
        <form className="pl-sheet-form" onSubmit={(e) => void save(e)} noValidate>
          <label htmlFor={ids.name} className="partner-field">
            {t("miniapp.partner.prices.name")}
            <input
              id={ids.name}
              ref={nameRef}
              value={name}
              maxLength={120}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label htmlFor={ids.price} className="partner-field">
            {t("miniapp.partner.prices.price")}
            <input
              id={ids.price}
              value={price}
              inputMode="decimal"
              autoComplete="off"
              placeholder="180"
              required
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label className="pl-check">
            <input type="checkbox" checked={from} onChange={(e) => setFrom(e.target.checked)} />
            {t("miniapp.partner.prices.priceFrom")}
          </label>
          <div className="partner-field">
            <label htmlFor={ids.unit}>{t("miniapp.partner.prices.unit")}</label>
            <input
              id={ids.unit}
              value={unit}
              maxLength={40}
              list={ids.units}
              aria-describedby={`${ids.unit}-hint`}
              onChange={(e) => setUnit(e.target.value)}
            />
            <small id={`${ids.unit}-hint`} className="partner-field-hint">
              {t("miniapp.partner.prices.unitHint")}
            </small>
            <datalist id={ids.units}>
              {UNITS.map((key) => (
                <option key={key} value={t(key)} />
              ))}
            </datalist>
          </div>
          <label htmlFor={ids.desc} className="partner-field">
            {t("miniapp.partner.prices.description")}
            <textarea
              id={ids.desc}
              rows={2}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {editing && sections.length > 1 && (
            <label htmlFor={sectionField} className="partner-field">
              {t("miniapp.partner.prices.section")}
              <select id={sectionField} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title.uk}
                  </option>
                ))}
              </select>
            </label>
          )}
          {editing && (
            <label className="pl-check">
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              {t("miniapp.partner.prices.hideItem")}
            </label>
          )}
          <Live message={local ?? message} testId="price-sheet-message" />
          <div className="partner-row">
            <button type="submit" className="pl-btn" data-variant="primary" disabled={busy}>
              {t("miniapp.partner.prices.save")}
            </button>
            <button type="button" className="pl-btn" onClick={close}>
              {t("miniapp.partner.prices.cancel")}
            </button>
            {editing &&
              (confirm ? (
                <button
                  type="button"
                  className="pl-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => void archive()}
                >
                  {t("miniapp.partner.prices.archiveItemConfirm")}
                </button>
              ) : (
                <button type="button" className="pl-btn" disabled={busy} onClick={() => setConfirm(true)}>
                  {t("miniapp.partner.prices.archive")}
                </button>
              ))}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
