// Фото заведения: одна кнопка «Додати фото» (несколько файлов, загрузка сразу), подпись необязательна,
// «Обкладинка» на первом, удаление с подтверждением в нижнем листе (ConfirmSheet — и для удаления черновика). Поток загрузки — api.uploadPhoto (upload + confirm).
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { pickLocalized } from "@tg/i18n";
import { Button, useT } from "@tg/ui";
import { useErrorText } from "../host/errors.js";
import { useSheet } from "../guide/use-sheet.js";
import { usePartner } from "./context.js";
import { UploadRejectedError, type PartnerPlace } from "./partner-api.js";
import { Live, type Message } from "./parts.js";

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

type Upload = { key: number; file: File; alt: string; state: "uploading" | "error"; error?: string };

/** Нижний лист подтверждения необратимого действия (удаление фото, удаление черновика заведения). */
export function ConfirmSheet({
  title: heading,
  text,
  confirmLabel,
  cancelLabel,
  testId,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  testId: string;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  useSheet(ref, close);
  const title = useId();
  return createPortal(
    <div className="partner-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="partner-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid={testId}
      >
        <h2 id={title}>{heading}</h2>
        {children}
        <p>{text}</p>
        <Button onClick={onConfirm}>{confirmLabel}</Button>
        <Button onClick={close}>{cancelLabel}</Button>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmDelete({
  url,
  label,
  onConfirm,
  onClose,
}: {
  url: string | undefined;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <ConfirmSheet
      title={t("miniapp.partner.photos.confirmTitle")}
      text={t("miniapp.partner.photos.confirmText")}
      confirmLabel={t("miniapp.partner.photos.confirmYes")}
      cancelLabel={t("miniapp.partner.photos.cancel")}
      testId="photo-confirm"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {url && <img src={url} alt={label} className="partner-photo-preview" />}
    </ConfirmSheet>
  );
}

export function Photos({ place, onChanged }: { place: PartnerPlace; onChanged: () => void }) {
  const { t, locale } = useT();
  const { api } = usePartner();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [caption, setCaption] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [message, setMessage] = useState<Message>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const ids = { caption: useId(), hint: useId() };
  const disabled = !place.editable;

  const send = async (u: Upload) => {
    setUploads((us) => us.map((x) => (x.key === u.key ? { ...x, state: "uploading", error: undefined } : x)));
    try {
      await api.uploadPhoto(place.id, u.file, u.alt);
      setUploads((us) => us.filter((x) => x.key !== u.key));
      setMessage({ text: t("miniapp.partner.photos.uploaded"), alert: false });
      onChanged();
    } catch (err) {
      const text =
        err instanceof UploadRejectedError
          ? t("miniapp.partner.photos.uploadRejected")
          : errorText(err, "miniapp.partner.photos.error");
      setUploads((us) => us.map((x) => (x.key === u.key ? { ...x, state: "error", error: text } : x)));
    }
  };

  const choose = (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (input.current) input.current.value = "";
    if (!list.length) return;
    setMessage(null);
    const typed = caption.trim();
    setCaption("");
    const queued: Upload[] = [];
    const base = place.media.length + uploads.length;
    for (const file of list) {
      const key = ++seq.current;
      // Сервер требует подпись у каждого фото: без своей — «Название — Фото N».
      const alt =
        typed ||
        `${pickLocalized(place.name, locale)} — ${t("miniapp.partner.field.photo")} ${base + queued.length + 1}`;
      if (!PHOTO_TYPES.includes(file.type)) {
        queued.push({
          key,
          file,
          alt,
          state: "error",
          error: `${file.name}: ${t("miniapp.partner.photos.badType")}`,
        });
      } else queued.push({ key, file, alt, state: "uploading" });
    }
    setUploads((us) => [...us, ...queued]);
    // По одному: меньше нагрузки на телефон и канал, порядок фото — как выбраны.
    void (async () => {
      for (const u of queued) if (u.state === "uploading") await send(u);
    })();
  };

  const remove = async (assetId: string) => {
    setAsking(null);
    setDeleting(true);
    setMessage(null);
    try {
      await api.deletePhoto(place.id, assetId);
      setMessage({ text: t("miniapp.partner.photos.deleted"), alert: false });
      onChanged();
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.photos.deleteError"), alert: true });
    } finally {
      setDeleting(false);
    }
  };

  const media = [...place.media].sort((a, b) => a.sortOrder - b.sortOrder);
  const coverId = (media.find((m) => m.isCover) ?? media[0])?.mediaAssetId;
  const labelOf = (m: (typeof media)[number], i: number) =>
    m.alt ? pickLocalized(m.alt, locale) : `${t("miniapp.partner.field.photo")} ${i + 1}`;
  const asked = media.findIndex((m) => m.mediaAssetId === asking);

  return (
    <div className="partner-group" data-testid="photos-block">
      {!media.length && !uploads.length && <p>{t("miniapp.partner.photos.empty")}</p>}
      <ul className="partner-photos" data-testid="photos">
        {media.map((m, i) => {
          const url = place.mediaPreview[m.mediaAssetId];
          const label = labelOf(m, i);
          return (
            <li key={m.mediaAssetId} className="partner-photo">
              {url ? (
                <img src={url} alt={label} />
              ) : (
                <p className="partner-photo-wait">{t("miniapp.partner.photos.processing")}</p>
              )}
              {m.mediaAssetId === coverId && (
                <span className="partner-photo-cover">{t("miniapp.partner.photos.cover")}</span>
              )}
              <button
                type="button"
                className="partner-photo-delete"
                disabled={disabled || deleting}
                aria-label={`${t("miniapp.partner.photos.delete")}: ${label}`}
                onClick={() => setAsking(m.mediaAssetId)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          );
        })}
      </ul>
      {uploads.length > 0 && (
        <ul className="partner-list" data-testid="photo-uploads">
          {uploads.map((u) => (
            <li key={u.key} className="partner-upload" data-state={u.state}>
              <span className="partner-upload-name">{u.file.name}</span>
              {u.state === "uploading" ? (
                <span role="status">{t("miniapp.partner.photos.uploading")}</span>
              ) : (
                <>
                  <span role="alert">{u.error}</span>
                  <span className="partner-row">
                    {PHOTO_TYPES.includes(u.file.type) && (
                      <Button onClick={() => void send(u)}>{t("miniapp.partner.photos.retry")}</Button>
                    )}
                    <Button onClick={() => setUploads((us) => us.filter((x) => x.key !== u.key))}>
                      {t("miniapp.partner.photos.dismiss")}
                    </Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="partner-field">
        <label htmlFor={ids.caption}>{t("miniapp.partner.photos.caption")}</label>
        <input
          id={ids.caption}
          value={caption}
          maxLength={200}
          disabled={disabled}
          aria-describedby={ids.hint}
          onChange={(e) => setCaption(e.target.value)}
        />
        <span id={ids.hint} className="partner-field-hint">
          {t("miniapp.partner.photos.captionHint")}
        </span>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={PHOTO_TYPES.join(",")}
        data-testid="photo-input"
        tabIndex={-1}
        onChange={(e) => choose(e.target.files)}
      />
      <Button onClick={() => input.current?.click()} disabled={disabled}>
        {t("miniapp.partner.photos.add")}
      </Button>
      <p className="partner-field-hint">{t("miniapp.partner.photos.help")}</p>
      <Live message={message} testId="photos-message" />
      {asking && asked >= 0 && (
        <ConfirmDelete
          url={place.mediaPreview[asking]}
          label={labelOf(media[asked]!, asked)}
          onConfirm={() => void remove(asking)}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}
