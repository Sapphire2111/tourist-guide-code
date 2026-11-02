// Вход админа (ADR-0018): логин и пароль → POST /auth/admin/login → токен сессии admin_web.
import { useId, useState } from "react";
import { Button, Stack, useT } from "@tg/ui";
import { call, setToken, type ApiClient, type ApiError, type Session } from "./api.js";
import { ErrorBox, inputStyle } from "./ui.js";

/** 401 — всегда одно сообщение (не раскрываем, что именно не так: логин, пароль или блокировка). */
export function loginError(error: ApiError): ApiError {
  return error.status === 401 ? { status: 401, messageKey: "errors.auth.invalidCredentials" } : error;
}

export function Login({
  api,
  onLogin,
  notice,
}: {
  api: ApiClient;
  onLogin: (s: Session) => void;
  /** Причина показа входа (сессия завершилась). */
  notice?: string | null;
}) {
  const { t } = useT();
  const loginId = useId();
  const passwordId = useId();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const res = await call(api.POST("/auth/admin/login", { body: { login: login.trim(), password } }));
    setBusy(false);
    if (!res.ok) {
      setPassword("");
      return setError(loginError(res.error));
    }
    setToken(res.data.token);
    onLogin(res.data.session);
  };

  return (
    <main style={{ maxWidth: 400, margin: "10vh auto", padding: 24 }}>
      <form
        aria-labelledby="login-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap={2}>
          <h1 id="login-title" style={{ margin: 0 }}>
            {t("admin.login.title")}
          </h1>
          {notice && <p role="status">{notice}</p>}
          <label htmlFor={loginId}>{t("admin.login.login")}</label>
          <input
            id={loginId}
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            style={inputStyle}
          />
          <label htmlFor={passwordId}>{t("admin.login.password")}</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
          <ErrorBox error={error} />
          <Button type="submit" disabled={busy}>
            {t("admin.login.submit")}
          </Button>
        </Stack>
      </form>
    </main>
  );
}
