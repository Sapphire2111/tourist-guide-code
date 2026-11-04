// P01 дашборд партнёра и P13 выбор организации/заведения: статус места, переходы в P06/P07/P09 и заявки отеля
// (P10, блок 5), бронирования P04 и ресурсы (блок 7, флаг module.bookings). Только то, что есть в GET /partner/me —
// без финансов, рейтинга и метрик.
import { useEffect, useId } from "react";
import { pickLocalized } from "@tg/i18n";
import { Link, Stack, useFeatureFlag, useT } from "@tg/ui";
import { AsyncView, card } from "../guide/parts.js";
import { UnauthorizedError } from "../guide/types.js";
import { resolveSelection, usePartner, useRefreshMe } from "./context.js";
import { ModeSwitch, PlaceStatusInfo, roleKey } from "./parts.js";

export function PartnerDashboard() {
  const { t, locale } = useT();
  const { me, reloadMe, selection, select, notice, setNotice } = usePartner();
  // Сообщение с другого экрана — один раз: снимается при уходе из кабинета.
  useEffect(() => () => setNotice(null), [setNotice]);
  const hostRequests = useFeatureFlag("module.host_requests");
  const bookings = useFeatureFlag("module.bookings");
  const reviews = useFeatureFlag("module.reviews");
  const orgLabel = useId();
  const placeLabel = useId();
  useRefreshMe();
  if (me.status === "off") return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  return (
    <Stack>
      <h1>{t("miniapp.partner.title")}</h1>
      {notice && (
        <p role="status" data-testid="partner-notice">
          {notice}
        </p>
      )}
      <AsyncView
        state={me}
        retry={reloadMe}
        errorText={
          me.status === "error" && me.error instanceof UnauthorizedError
            ? t("miniapp.auth.again")
            : t("miniapp.partner.loadError")
        }
      >
        {({ organizations }) => {
          if (!organizations.length)
            return (
              <div className="kosiv-card kosiv-empty" data-testid="not-partner">
                <p>{t("miniapp.partner.notPartner")}</p>
                <Link to="/partner/new" className="kosiv-cta">
                  {t("miniapp.partner.become")}
                </Link>
              </div>
            );
          const { org, place } = resolveSelection(organizations, selection);
          return (
            <>
              <ModeSwitch current="partner" />
              {organizations.length > 1 && (
                <label htmlFor={orgLabel}>
                  {t("miniapp.partner.org")}
                  <select
                    id={orgLabel}
                    value={org?.id}
                    onChange={(e) => select({ orgId: e.target.value, placeId: null })}
                  >
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {org && (
                <p data-testid="partner-org">
                  <strong>{org.name}</strong>
                  <br />
                  {t("miniapp.partner.yourRole", { role: t(roleKey(org.role)) })}
                </p>
              )}
              {org && org.places.length > 1 && (
                <label htmlFor={placeLabel}>
                  {t("miniapp.partner.place")}
                  <select
                    id={placeLabel}
                    value={place?.id}
                    onChange={(e) => select({ orgId: org.id, placeId: e.target.value })}
                  >
                    {org.places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {pickLocalized(p.name, locale)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {org && !place && <p>{t("miniapp.partner.noPlaces")}</p>}
              {org && place && (
                <section style={card} data-testid="partner-place">
                  <h2 style={{ margin: 0 }}>{pickLocalized(place.name, locale)}</h2>
                  <PlaceStatusInfo status={place.status} moderation={place.moderation} />
                  <Stack>
                    {org.abilities.editPlace && (
                      <Link to={`/partner/place/${place.id}`} className="kosiv-cta">
                        {t("miniapp.partner.editPlace")}
                      </Link>
                    )}
                    {org.abilities.manageOffers && place.modules.includes("offers") && (
                      <Link to={`/partner/place/${place.id}/offers`}>
                        {t("miniapp.partner.offersLink", { count: place.activeOffers })}
                      </Link>
                    )}
                    {bookings && (
                      <Link to={`/partner/place/${place.id}/bookings`} data-testid="partner-bookings-link">
                        {t("miniapp.pbooking.title")}
                      </Link>
                    )}
                    {bookings && (
                      <Link to={`/partner/place/${place.id}/resources`}>
                        {t("miniapp.pbooking.resourcesLink")}
                      </Link>
                    )}
                    {reviews && (
                      <Link to={`/partner/place/${place.id}/reviews`} data-testid="partner-reviews-link">
                        {t("miniapp.partner.reviews.link")}
                      </Link>
                    )}
                    {org.abilities.serviceRequests && hostRequests && place.openServiceRequests !== null && (
                      <Link to="/staff">
                        {t("miniapp.partner.requestsLink", { count: place.openServiceRequests })}
                      </Link>
                    )}
                  </Stack>
                </section>
              )}
              {org?.abilities.manageStaff && (
                <Link to={`/partner/org/${org.id}/staff`}>{t("miniapp.partner.staffLink")}</Link>
              )}
              {/* Онбординг создаёт новую организацию — только тем, кто уже владелец (не кассиру/менеджеру). */}
              {organizations.some((o) => o.role === "ORG_OWNER") && (
                <Link to="/partner/new">{t("miniapp.partner.addPlace")}</Link>
              )}
            </>
          );
        }}
      </AsyncView>
    </Stack>
  );
}
