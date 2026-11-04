// C15 «Профіль»: язык, имя, разрешения боту писать (отзыв), запросы экспорта/удаления данных (каркас D-48).
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@tg/api-client";
import { SUPPORTED_LOCALES, type Locale } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { clearAssistantDialog } from "./assistant/dialog-store.js";
import { clearNavigationData } from "./back.js";
import { messagingGranted } from "./consents.js";
import { requestWriteAccess } from "./Entry.js";
import { useScreenState } from "./screen-state.js";
import type { Me } from "./session.js";
import type { TelegramWebApp } from "./telegram.js";

type Kind = "export" | "delete";

export function Profile({
  api,
  me,
  webApp,
  onChange,
}: {
  api: ApiClient;
  me: Me;
  webApp?: TelegramWebApp;
  onChange: (me: Me) => void;
}) {
  const { t } = useT();
  // Черновик имени переживает переход в «Мої бронювання» и обратно (только в памяти).
  const [name, setName] = useScreenState("profile.name", me.displayName ?? "", { inMemoryOnly: true });
  const [status, setStatus] = useState<"idle" | "saved" | "error" | "noAccess">("idle");
  /** Удаление — только после второго нажатия (подтверждения). */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Идёт requestWriteAccess/POST messaging-consent: переключатели неактивны (без параллельных запросов). */
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Фокус на «Скасувати»: повторный Enter/Space на исходной кнопке не подтверждает удаление.
  useEffect(() => {
    if (confirmDelete) cancelRef.current?.focus();
  }, [confirmDelete]);

  const refresh = async () => {
    const res = await api.GET("/me");
    if (res.data) onChange(res.data);
  };
  const done = (ok: boolean) => setStatus(ok ? "saved" : "error");

  const setLanguage = async (language: Locale) => {
    const res = await api.PATCH("/me", { body: { language } });
    if (res.data) onChange(res.data);
    done(!!res.data);
  };
  const saveName = async () => {
    const trimmed = name.trim();
    const res = await api.PATCH("/me", { body: { displayName: trimmed ? trimmed : null } });
    if (res.data) onChange(res.data);
    done(!!res.data);
  };
  const setMessaging = async (purpose: "service" | "marketing", granted: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      // Включение сервисных: сначала разрешение Telegram писать; без него согласие не включаем.
      if (purpose === "service" && granted && (await requestWriteAccess(webApp)) !== true) {
        setStatus("noAccess");
        return;
      }
      const res = await api.POST("/me/messaging-consent", { body: { purpose, granted, source: "settings" } });
      done(!res.error);
      await refresh();
    } catch {
      done(false);
    } finally {
      setBusy(false);
    }
  };
  const requestData = async (kind: Kind) => {
    setConfirmDelete(false);
    const res = await api.POST("/me/privacy-requests", { body: { kind } });
    // Запрос на удаление — локальная история ассистента и сохранённое состояние экранов вкладки тоже стираются.
    if (kind === "delete" && !res.error) {
      clearAssistantDialog();
      clearNavigationData();
    }
    done(!res.error);
    await refresh();
  };
  const openRequest = (kind: Kind) => me.privacyRequests.find((r) => r.kind === kind);

  const service = messagingGranted(me, "service");
  const marketing = messagingGranted(me, "marketing");
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(me.language) ? me.language : "uk";

  return (
    <Stack>
      <label>
        {t("miniapp.profile.language")}{" "}
        <select value={locale} onChange={(e) => void setLanguage(e.target.value as Locale)}>
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`miniapp.locale.${l}`)}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveName();
        }}
      >
        <label>
          {t("miniapp.profile.displayName")}{" "}
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>{" "}
        <Button type="submit">{t("miniapp.profile.save")}</Button>
      </form>
      <fieldset>
        <legend>{t("miniapp.profile.consents")}</legend>
        <label>
          <input
            type="checkbox"
            checked={service}
            disabled={busy}
            onChange={(e) => void setMessaging("service", e.target.checked)}
          />{" "}
          {t("miniapp.profile.service")}
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={marketing}
            disabled={!service || busy}
            onChange={(e) => void setMessaging("marketing", e.target.checked)}
          />{" "}
          {t("miniapp.profile.marketing")}
        </label>
      </fieldset>
      <section aria-labelledby="privacy-title">
        <h2 id="privacy-title">{t("miniapp.profile.privacy")}</h2>
        {me.privacyRequests.length > 0 && (
          <ul data-testid="privacy-requests">
            {me.privacyRequests.map((r) => (
              <li key={r.id}>
                {t("miniapp.profile.requestItem", {
                  kind: t(`miniapp.profile.request.${r.kind}`),
                  status: t(`miniapp.profile.requestStatus.${r.status}`),
                })}
              </li>
            ))}
          </ul>
        )}
        <Stack gap={1}>
          <Button disabled={!!openRequest("export")} onClick={() => void requestData("export")}>
            {t("miniapp.profile.export")}
          </Button>
          {confirmDelete && <p role="alert">{t("miniapp.profile.deleteConfirm")}</p>}
          <Button disabled={!!openRequest("delete") || confirmDelete} onClick={() => setConfirmDelete(true)}>
            {t("miniapp.profile.delete")}
          </Button>
          {confirmDelete && (
            <>
              <Button onClick={() => void requestData("delete")}>
                {t("miniapp.profile.deleteConfirmButton")}
              </Button>
              <Button ref={cancelRef} onClick={() => setConfirmDelete(false)}>
                {t("miniapp.profile.cancel")}
              </Button>
            </>
          )}
        </Stack>
      </section>
      {status !== "idle" && (
        <p role={status === "saved" ? "status" : "alert"}>
          {t(
            status === "saved"
              ? "miniapp.profile.saved"
              : status === "noAccess"
                ? "miniapp.profile.noWriteAccess"
                : "miniapp.profile.error",
          )}
        </p>
      )}
    </Stack>
  );
}
