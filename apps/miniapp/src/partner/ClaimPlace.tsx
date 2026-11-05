// «Це мій заклад» (0031): заявка на место каталога (обычно импорт Google) вместо дубля карточки. Один экран: роль
// (власник / керуючий), телефон (requestContact Telegram или вручную), организация — своя (ORG_OWNER в регионе) или
// новая по названию, необязательный комментарий. Модератор проверяет вручную; статус — в кабинете партнёра (P01).
import { useEffect, useId, useRef, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { normalizePhone } from "../bookings/format.js";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView, card } from "../guide/parts.js";
import { NotFoundError, type PlaceDetail } from "../guide/types.js";
import { useErrorText } from "../host/errors.js";
import type { TelegramWebApp } from "../telegram.js";
import { usePartner, usePartnerOrgs } from "./context.js";
import { keepsIdempotencyKey, type PlaceClaim, type PlaceClaimRole } from "./partner-api.js";
import { ClaimStatus } from "./ClaimsList.js";
import { Live, newKey, type Message } from "./parts.js";

/** Bot API 6.9+: запрос номера пользователя; номер — в responseUnsafe.contact. */
type ContactResponse = { responseUnsafe?: { contact?: { phone_number?: string } } };
type ContactWebApp = TelegramWebApp & {
  requestContact?(cb?: (sent: boolean, res?: ContactResponse) => void): void;
};

const ROLES: readonly PlaceClaimRole[] = ["owner", "manager"];
const NEW_ORG = "new";
/** Строка выбора — цель касания 44 px. */
const choice = { display: "flex", alignItems: "center", gap: 8, minHeight: 44 } as const;
const plainFieldset = { border: 0, padding: 0, margin: 0 } as const;

export function ClaimPlace({ placeId }: { placeId: string }) {
  const { t } = useT();
  const guide = useGuide();
  const { api, regionId, enabled } = usePartner();
  const [state, retry] = useAsync(async () => {
    const [place, claims] = await Promise.all([
      guide.api.place(placeId),
      enabled && regionId ? api.claims(regionId) : Promise.resolve([] as PlaceClaim[]),
    ]);
    return { place, claims };
  }, [guide.api, api, regionId, enabled, placeId]);
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  if (state.status === "error" && state.error instanceof NotFoundError)
    return <p role="alert">{t("miniapp.place.notFound")}</p>;
  return (
    <AsyncView state={state} retry={retry} errorText={t("miniapp.claim.error")}>
      {({ place, claims }) => <ClaimForm place={place} claims={claims} />}
    </AsyncView>
  );
}

function ClaimForm({ place, claims }: { place: PlaceDetail; claims: PlaceClaim[] }) {
  const { t, locale } = useT();
  const { webApp } = useGuide();
  const { api, regionId, reloadMe } = usePartner();
  const errorText = useErrorText();
  const placeName = pickLocalized(place.name, locale);
  // Организации, куда заявитель может привязать место: где он владелец, в регионе места.
  const ownOrgs = usePartnerOrgs().filter((o) => o.role === "ORG_OWNER" && o.regionId === regionId);
  const [role, setRole] = useState<PlaceClaimRole>("owner");
  const [phoneRaw, setPhoneRaw] = useState("");
  const [phoneSource, setPhoneSource] = useState<"telegram_contact" | "manual">("manual");
  const [org, setOrg] = useState<string>(NEW_ORG);
  const [orgName, setOrgName] = useState(placeName);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [sent, setSent] = useState<PlaceClaim | null>(null);
  const ids = { phone: useId(), phoneHint: useId(), org: useId(), orgHint: useId(), comment: useId() };
  // Повтор после сбоя сети не создаст вторую заявку; правка формы — новый ключ.
  const key = useRef(newKey());
  useEffect(() => {
    key.current = newKey();
  }, [role, phoneRaw, org, orgName, comment]);
  const phone = normalizePhone(phoneRaw);
  const tg = webApp as ContactWebApp | undefined;
  const pending = sent ?? claims.find((c) => c.placeId === place.id && c.status === "pending") ?? null;

  if (pending)
    return (
      <Stack>
        <h1>{t("miniapp.claim.title")}</h1>
        <section style={card} data-testid="claim-pending">
          <h2 style={{ margin: 0 }}>{placeName}</h2>
          <ClaimStatus claim={pending} />
          <p role="status">{t(sent ? "miniapp.claim.sent" : "miniapp.claim.pendingExists")}</p>
        </section>
        <Link to="/partner" className="kosiv-cta">
          {t("miniapp.claim.toCabinet")}
        </Link>
      </Stack>
    );
  if (place.claimable === false)
    return (
      <Stack>
        <h1>{t("miniapp.claim.title")}</h1>
        <p role="alert">{t("miniapp.claim.claimed")}</p>
      </Stack>
    );

  const shareContact = () => {
    setMessage(null);
    tg?.requestContact?.((ok, res) => {
      const number = res?.responseUnsafe?.contact?.phone_number;
      const normalized = number ? normalizePhone(number.startsWith("+") ? number : `+${number}`) : null;
      if (ok && normalized) {
        setPhoneRaw(normalized);
        setPhoneSource("telegram_contact");
      } else
        setMessage({
          text: t(ok ? "miniapp.booking.contactNoData" : "miniapp.booking.contactCancelled"),
          alert: ok,
        });
    });
  };

  const submit = async () => {
    if (!phone) return setMessage({ text: t("miniapp.booking.phoneInvalid"), alert: true });
    if (org === NEW_ORG && !orgName.trim())
      return setMessage({ text: t("miniapp.claim.orgRequired"), alert: true });
    if (!regionId) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.createClaim(
        {
          regionId,
          placeId: place.id,
          role,
          phone,
          phoneSource,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(org === NEW_ORG ? { organizationName: orgName.trim() } : { organizationId: org }),
        },
        key.current,
      );
      key.current = newKey();
      setSent(created);
      reloadMe();
    } catch (err) {
      if (!keepsIdempotencyKey(err)) key.current = newKey();
      setMessage({ text: errorText(err, "miniapp.claim.error"), alert: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <h1>{t("miniapp.claim.title")}</h1>
      <p>{t("miniapp.claim.intro", { place: placeName })}</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
      >
        <Stack>
          <fieldset style={plainFieldset}>
            <legend>{t("miniapp.claim.role")}</legend>
            {ROLES.map((r) => (
              <label key={r} style={choice}>
                <input
                  type="radio"
                  name="claim-role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                />
                {t(r === "owner" ? "miniapp.claim.role.owner" : "miniapp.claim.role.manager")}
              </label>
            ))}
          </fieldset>
          <label htmlFor={ids.phone}>
            {t("miniapp.claim.phone")}
            <input
              id={ids.phone}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+380…"
              value={phoneRaw}
              aria-describedby={ids.phoneHint}
              aria-invalid={phoneRaw !== "" && !phone ? true : undefined}
              onChange={(e) => {
                setPhoneRaw(e.target.value);
                setPhoneSource("manual");
              }}
            />
          </label>
          <p id={ids.phoneHint} className="kosiv-muted" style={{ margin: 0 }}>
            {t("miniapp.claim.privacy")}
          </p>
          {typeof tg?.requestContact === "function" && (
            <Button type="button" onClick={shareContact} data-testid="claim-share-contact">
              {t("miniapp.booking.shareContact")}
            </Button>
          )}
          {ownOrgs.length > 0 ? (
            <fieldset style={plainFieldset}>
              <legend>{t("miniapp.claim.org")}</legend>
              {ownOrgs.map((o) => (
                <label key={o.id} style={choice}>
                  <input
                    type="radio"
                    name="claim-org"
                    value={o.id}
                    checked={org === o.id}
                    onChange={() => setOrg(o.id)}
                  />
                  {o.name}
                </label>
              ))}
              <label style={choice}>
                <input
                  type="radio"
                  name="claim-org"
                  value={NEW_ORG}
                  checked={org === NEW_ORG}
                  onChange={() => setOrg(NEW_ORG)}
                />
                {t("miniapp.claim.org.new")}
              </label>
            </fieldset>
          ) : null}
          {org === NEW_ORG && (
            <>
              <label htmlFor={ids.org}>
                {t("miniapp.claim.orgName")}
                <input
                  id={ids.org}
                  value={orgName}
                  maxLength={200}
                  aria-describedby={ids.orgHint}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </label>
              <p id={ids.orgHint} className="kosiv-muted" style={{ margin: 0 }}>
                {t("miniapp.claim.orgNameHint")}
              </p>
            </>
          )}
          <label htmlFor={ids.comment}>
            {t("miniapp.claim.comment")}
            <textarea
              id={ids.comment}
              rows={3}
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <Live message={message} testId="claim-message" />
          <Button type="submit" disabled={busy} data-testid="claim-submit">
            {t(busy ? "miniapp.claim.sending" : "miniapp.claim.submit")}
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}
