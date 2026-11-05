import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveLocale } from "@tg/i18n";
import "./design/kosiv.css";
import "./design/modern.css";
import "./design/partner.css";
import { App } from "./App.js";
import { api } from "./api.js";
import { getStubRole } from "./role.js";
import { createStartup } from "./session.js";
import { getWebApp, initTelegram } from "./telegram.js";

const webApp = getWebApp();
if (webApp) initTelegram(webApp);
const user = webApp?.initDataUnsafe?.user;
// Создаётся один раз за открытие (вне React): StrictMode не вызовет вход и GET /context дважды.
const startup = webApp ? createStartup(api, webApp) : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      api={api}
      role={getStubRole()}
      user={user}
      webApp={webApp}
      startup={startup}
      locale={resolveLocale(user?.language_code)}
    />
  </StrictMode>,
);
