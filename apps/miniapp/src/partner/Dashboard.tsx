// P01 дашборд партнёра и P13 выбор организации/заведения: h1 — название заведения, карточка статуса с одним действием,
// прогресс «Заповнено N з M», «Що далі» и плитки разделов (P06/P07/P09/P10, бронирования P04, отзывы, прайс).
// Только то, что есть в GET /partner/me и GET /partner/places/{id} — без финансов, рейтинга и метрик.
import { useEffect, useId, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Link, Stack, useFeatureFlag, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { AsyncView } from "../guide/parts.js";
import { UnauthorizedError } from "../guide/types.js";
import { MyClaims } from "./ClaimsList.js";
import { resolveSelection, usePartner, useRefreshMe } from "./context.js";
import type { PartnerField, PartnerOrganization, PartnerPlaceSummary } from "./partner-api.js";
import { NextSteps, PlaceStatusCard, ProgressBar, roleKey } from "./parts.js";

/** Секции редактора (якоря задаёт PlaceEditor, переход — ?section=<id>): поле шаблона → секция. */
type Section = "basic" | "photos" | "schedule";
const SECTION_OF: Record<PartnerField, Section> = {
  name: "basic",
  category: "basic",
  description: "basic",
  address: "basic",
  location: "basic",
  phone: "basic",
  schedule: "schedule",
  photo: "photos",
};
const SECTIONS: readonly Section[] = ["basic", "photos", "schedule"];
const NEXT_LABEL: Record<Section, MessageKey> = {
  basic: "miniapp.partner.next.basic",
  photos: "miniapp.partner.next.photos",
  schedule: "miniapp.partner.next.schedule",
};

function Tile({
  to,
  icon,
  label,
  note,
  testId,
}: {
  to: string;
  icon: string;
  label: string;
  note?: string;
  testId?: string;
}) {
  return (
    <li>
      <Link to={to} className="partner-tile" data-testid={testId}>
        <span className="partner-tile-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{label}</span>
        {note && <small>{note}</small>}
      </Link>
    </li>
  );
}

function PlaceCabinet({ org, place }: { org: PartnerOrganization; place: PartnerPlaceSummary }) {
  const { t } = useT();
  const { api } = usePartner();
  const hostRequests = useFeatureFlag("module.host_requests");
  const bookings = useFeatureFlag("module.bookings");
  const reviews = useFeatureFlag("module.reviews");
  // Полная карточка нужна только для прогресса: ошибка загрузки — блока прогресса просто нет.
  const [full] = useAsync(
    () => (place.templateCode ? api.place(place.id) : Promise.resolve(null)),
    [api, place.id, place.templateCode, place.status],
  );
  const detail = full.status === "ready" ? full.data : null;
  const editor = `/partner/place/${place.id}`;
  const canEdit = org.abilities.editPlace && !!place.templateCode;
  const status = place.status;
  const editable = status === "draft" || status === "changes_requested" || status === "rejected";

  let action: ReactNode = null;
  if (canEdit && status === "draft")
    action = (
      <Link to={editor} className="kosiv-cta">
        {t("miniapp.partner.action.continue")}
      </Link>
    );
  else if (canEdit && (status === "changes_requested" || status === "rejected"))
    action = (
      <Link to={editor} className="kosiv-cta">
        {t("miniapp.partner.action.fix")}
      </Link>
    );
  else if (status === "published")
    action = (
      <Link to={`/place/${place.id}`} className="kosiv-cta">
        {t("miniapp.partner.action.viewAsTourist")}
      </Link>
    );

  const required = detail?.template.requiredFields.length ?? 0;
  const missing = detail?.missingFields ?? [];
  const steps: { to: string; label: string }[] = [];
  if (canEdit && editable) {
    const need = new Set(missing.map((f) => SECTION_OF[f]));
    for (const s of SECTIONS)
      if (need.has(s)) steps.push({ to: `${editor}?section=${s}`, label: t(NEXT_LABEL[s]) });
    if (detail && !missing.length && org.abilities.submit)
      steps.push({ to: editor, label: t("miniapp.partner.next.submit") });
  }
  if (
    status === "published" &&
    org.abilities.manageOffers &&
    place.modules.includes("offers") &&
    !place.activeOffers
  )
    steps.push({ to: `${editor}/offers`, label: t("miniapp.partner.next.offer") });

  return (
    <>
      <div data-testid="partner-place">
        <PlaceStatusCard status={status} moderation={place.moderation} action={action} />
      </div>
      {detail && editable && <ProgressBar done={required - missing.length} total={required} />}
      <NextSteps steps={steps} />
      <nav aria-label={t("miniapp.partner.tiles.title")}>
        <ul className="partner-tiles">
          {/* Без шаблона редактора нет; одобренная заявка «Це мій заклад» всегда даёт шаблон (подходящий или base). */}
          {canEdit && <Tile to={editor} icon="📝" label={t("miniapp.partner.tile.profile")} />}
          {/* Прайс работает через место с шаблоном (inPlace), как редактор. */}
          {org.abilities.managePriceList && place.templateCode && (
            <Tile
              to={`${editor}/prices`}
              icon="🍽️"
              label={t("miniapp.partner.tile.prices")}
              testId="partner-prices-link"
            />
          )}
          {org.abilities.manageOffers && place.modules.includes("offers") && (
            <Tile
              to={`${editor}/offers`}
              icon="🏷️"
              label={t("miniapp.partner.tile.offers")}
              note={t("miniapp.partner.tile.offersCount", { count: place.activeOffers })}
            />
          )}
          {/* review.respond есть у ORG_OWNER и ORG_MANAGER (rbac/roles.ts); у кассира/сотрудника — нет. */}
          {reviews && org.role !== "ORG_STAFF" && (
            <Tile
              to={`${editor}/reviews`}
              icon="⭐"
              label={t("miniapp.partner.reviews.link")}
              testId="partner-reviews-link"
            />
          )}
          {bookings && (
            <Tile
              to={`${editor}/bookings`}
              icon="📅"
              label={t("miniapp.pbooking.title")}
              testId="partner-bookings-link"
            />
          )}
          {bookings && (
            <Tile to={`${editor}/resources`} icon="🪑" label={t("miniapp.pbooking.resourcesLink")} />
          )}
          {org.abilities.manageStaff && (
            <Tile
              to={`/partner/org/${org.id}/staff`}
              icon="👥"
              label={t("miniapp.partner.tile.team")}
              testId="partner-team-link"
            />
          )}
          {org.abilities.serviceRequests && hostRequests && place.openServiceRequests !== null && (
            <Tile
              to="/staff"
              icon="🛎️"
              label={t("miniapp.partner.tile.requests")}
              note={t("miniapp.partner.tile.requestsCount", { count: place.openServiceRequests })}
            />
          )}
        </ul>
      </nav>
    </>
  );
}

export function PartnerDashboard() {
  const { t, locale } = useT();
  const { me, reloadMe, selection, select, notice, setNotice } = usePartner();
  // Сообщение с другого экрана — один раз: снимается при уходе из кабинета.
  useEffect(() => () => setNotice(null), [setNotice]);
  const orgLabel = useId();
  useRefreshMe();
  if (me.status === "off") return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  const resolved =
    me.status === "ready" && me.data.organizations.length
      ? resolveSelection(me.data.organizations, selection)
      : null;
  const title = resolved?.place ? pickLocalized(resolved.place.name, locale) : t("miniapp.partner.title");
  return (
    <Stack>
      <Link to="/" className="partner-back" data-testid="to-tourist">
        {t("miniapp.partner.toTourist")}
      </Link>
      <h1>{title}</h1>
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
              <>
                {/* Заявка «Це мій заклад» на рассмотрении — статус до появления организации. */}
                <MyClaims />
                <div className="kosiv-card kosiv-empty" data-testid="not-partner">
                  <p>{t("miniapp.partner.notPartner")}</p>
                  <Link to="/partner/new" className="kosiv-cta">
                    {t("miniapp.partner.become")}
                  </Link>
                </div>
              </>
            );
          const { org, place } = resolveSelection(organizations, selection);
          return (
            <>
              {/* Заявка «Це мій заклад» — статус сверху, пока есть что показать. */}
              <MyClaims />
              {organizations.length > 1 && (
                <label htmlFor={orgLabel} className="partner-field">
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
              {org && org.role !== "ORG_OWNER" && (
                <small className="partner-role" data-testid="partner-org">
                  {org.name} · {t("miniapp.partner.yourRole", { role: t(roleKey(org.role)) })}
                </small>
              )}
              {org && org.places.length > 1 && (
                <div role="group" aria-label={t("miniapp.partner.venues")} className="partner-chips">
                  {org.places.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="kosiv-chip"
                      aria-pressed={p.id === place?.id}
                      onClick={() => select({ orgId: org.id, placeId: p.id })}
                    >
                      {pickLocalized(p.name, locale)}
                    </button>
                  ))}
                </div>
              )}
              {org && !place && <p>{t("miniapp.partner.noPlaces")}</p>}
              {org && place && <PlaceCabinet key={place.id} org={org} place={place} />}
              {/* Онбординг создаёт новую организацию — только тем, кто уже владелец (не кассиру/менеджеру). */}
              {organizations.some((o) => o.role === "ORG_OWNER") && (
                <Link to="/partner/new" className="partner-back">
                  {t("miniapp.partner.addPlace")}
                </Link>
              )}
            </>
          );
        }}
      </AsyncView>
    </Stack>
  );
}
