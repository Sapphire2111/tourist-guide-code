// C14 «Халепа?»: экстренные контакты региона, звонок в одно нажатие (tel:). Без согласий и без геолокации
// (C-31); 112 показывается всегда — даже если контакты не загрузились. Геолокация — только по кнопке.
import { useState, type CSSProperties } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { requestLocation, type LatLng } from "./geo.js";
import { card } from "./parts.js";

const callLink: CSSProperties = {
  display: "block",
  padding: "12px 16px",
  borderRadius: "var(--radius)",
  background: "var(--color-button)",
  color: "var(--color-button-text)",
  fontSize: "1.25rem",
  fontWeight: 700,
  textDecoration: "none",
};

export function Help() {
  const { t, locale } = useT();
  const { api, webApp } = useGuide();
  const [contacts] = useAsync(() => api.emergencyContacts(), [api]);
  const [geo, setGeo] = useState<"idle" | "locating" | "denied" | LatLng>("idle");

  return (
    <Stack>
      <h1>{t("miniapp.help.title")}</h1>
      <p>{t("miniapp.help.intro")}</p>
      <a href="tel:112" style={callLink} data-testid="call-112">
        {t("miniapp.help.general")}
      </a>
      {contacts.status === "loading" && <p role="status">{t("miniapp.guide.loading")}</p>}
      {contacts.status === "error" && <p role="alert">{t("miniapp.help.error")}</p>}
      {contacts.status === "ready" &&
        (contacts.data.length === 0 ? (
          <p data-testid="help-empty">{t("miniapp.help.empty")}</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="help-contacts">
            <Stack gap={1}>
              {contacts.data.map((c) => {
                const name = pickLocalized(c.name, locale);
                return (
                  <li key={c.id} style={card}>
                    <p style={{ margin: "0 0 6px" }}>{t(`miniapp.help.kind.${c.kind}` as MessageKey)}</p>
                    <a
                      href={`tel:${c.phone}`}
                      style={callLink}
                      aria-label={t("miniapp.help.call", { name, phone: c.phone })}
                    >
                      {name}: {c.phone}
                    </a>
                    {c.description && (
                      <p style={{ margin: "6px 0 0" }}>{pickLocalized(c.description, locale)}</p>
                    )}
                  </li>
                );
              })}
            </Stack>
          </ul>
        ))}
      <Button
        disabled={geo === "locating"}
        onClick={() => {
          setGeo("locating");
          void requestLocation(webApp).then((p) => setGeo(p ?? "denied"));
        }}
      >
        {geo === "locating" ? t("miniapp.nearby.locating") : t("miniapp.help.shareLocation")}
      </Button>
      {geo === "denied" && <p role="alert">{t("miniapp.help.locationDenied")}</p>}
      {typeof geo === "object" && (
        <p role="status" data-testid="help-location">
          {t("miniapp.help.locationShown", { lat: geo.lat.toFixed(5), lng: geo.lng.toFixed(5) })}
        </p>
      )}
    </Stack>
  );
}
