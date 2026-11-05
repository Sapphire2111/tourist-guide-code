// P12 «Стати партнером» (S-05): шаблон (GET /partner/templates) → категория и название → POST /partner/onboarding
// → редактор P06 нового черновика. Статус модерации и отправка — в P06.
import { useEffect, useId, useRef, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useRoute, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { AsyncView } from "../guide/parts.js";
import { useErrorText } from "../host/errors.js";
import { usePartner } from "./context.js";
import { keepsIdempotencyKey } from "./partner-api.js";
import { Live, newKey, PartnerHeader, type Message } from "./parts.js";

/** Иконка плитки по коду шаблона; незнакомый код — общая метка. */
const iconOf = (code: string) =>
  /hotel|stay|lodg|садиб/i.test(code)
    ? "🏨"
    : /cafe|restaurant|food|bar/i.test(code)
      ? "🍽️"
      : /shop|store|market/i.test(code)
        ? "🛍️"
        : /guide|tour|excurs/i.test(code)
          ? "🧭"
          : /charg|fuel|auto|car/i.test(code)
            ? "🔌"
            : "📍";

export function PartnerOnboarding() {
  const { t, locale } = useT();
  const [, navigate] = useRoute();
  const { api, regionId, enabled, reloadMe, select } = usePartner();
  const errorText = useErrorText();
  const [templates, retry] = useAsync(
    () => (enabled && regionId ? api.templates(regionId) : Promise.resolve([])),
    [api, regionId, enabled],
  );
  const [code, setCode] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  // Один ключ на попытку создания: повтор после сбоя сети не создаст второе заведение.
  // Сервер хранит ответ по ключу (и 4xx): после окончательной ошибки или правки формы — новый ключ.
  const key = useRef(newKey());
  useEffect(() => {
    key.current = newKey();
  }, [code, categoryId, name]);
  const ids = { category: useId(), name: useId() };
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;

  return (
    <Stack>
      <PartnerHeader title={t("miniapp.partner.onboarding.title")} />
      <p>{t("miniapp.partner.onboarding.lead")}</p>
      <p className="kosiv-card" data-testid="onboarding-exists" style={{ margin: 0 }}>
        {t("miniapp.partner.onboarding.exists")}{" "}
        <Link to="/search?claim=1" className="partner-back" data-testid="onboarding-search">
          {t("miniapp.partner.onboarding.search")}
        </Link>
      </p>
      <AsyncView state={templates} retry={retry} errorText={t("miniapp.partner.loadError")}>
        {(items) => {
          const available = items.filter((x) => x.categories.length > 0);
          if (!available.length) return <p>{t("miniapp.partner.onboarding.noTemplates")}</p>;
          const template = available.find((x) => x.code === code) ?? null;
          const create = async () => {
            if (template && template.categories.length > 1 && !categoryId && name.trim()) {
              setMessage({ text: t("miniapp.partner.onboarding.pickCategory"), alert: true });
              return;
            }
            if (!template || !categoryId || !name.trim() || !regionId) {
              setMessage({ text: t("miniapp.partner.onboarding.incomplete"), alert: true });
              return;
            }
            setBusy(true);
            setMessage(null);
            try {
              const place = await api.onboard(
                {
                  regionId,
                  templateCode: template.code,
                  categoryId,
                  name: { uk: name.trim() },
                  // Организация по умолчанию называется как заведение (поле не показываем).
                  organizationName: name.trim(),
                },
                key.current,
              );
              key.current = newKey();
              select({ orgId: place.organizationId, placeId: place.id });
              reloadMe();
              // Заменой: «Назад» не возвращает на форму, которая создала бы второе заведение.
              navigate(`/partner/place/${place.id}`, { replace: true });
            } catch (err) {
              if (!keepsIdempotencyKey(err)) key.current = newKey();
              setMessage({ text: errorText(err, "miniapp.partner.onboarding.error"), alert: true });
            } finally {
              setBusy(false);
            }
          };
          return (
            <>
              <fieldset className="partner-types">
                <legend>{t("miniapp.partner.onboarding.typeLegend")}</legend>
                {available.map((x) => (
                  <div
                    key={x.id}
                    className="partner-type-wrap"
                    data-checked={code === x.code ? "true" : undefined}
                  >
                    <label className="partner-type">
                      <input
                        type="radio"
                        name="template"
                        value={x.code}
                        checked={code === x.code}
                        aria-describedby={x.description ? `${ids.name}-d-${x.id}` : undefined}
                        onChange={() => {
                          setCode(x.code);
                          setCategoryId(x.categories.length === 1 ? x.categories[0]!.id : "");
                        }}
                      />
                      <span className="partner-tile-icon" aria-hidden="true">
                        {iconOf(x.code)}
                      </span>
                      <strong>{pickLocalized(x.name, locale)}</strong>
                      <span className="partner-type-check" aria-hidden="true">
                        ✓
                      </span>
                    </label>
                    {x.description && (
                      <small id={`${ids.name}-d-${x.id}`} className="partner-type-hint">
                        {pickLocalized(x.description, locale)}
                      </small>
                    )}
                  </div>
                ))}
              </fieldset>
              {template && template.categories.length > 1 && (
                <label htmlFor={ids.category} className="partner-field">
                  {t("miniapp.partner.field.category")}
                  <select
                    id={ids.category}
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">—</option>
                    {template.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {pickLocalized(c.name, locale)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label htmlFor={ids.name} className="partner-field">
                {t("miniapp.partner.onboarding.name")}
                <input id={ids.name} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </label>
              <Live message={message} testId="onboarding-message" />
              <Button onClick={() => void create()} disabled={busy}>
                {t("miniapp.partner.onboarding.create")}
              </Button>
            </>
          );
        }}
      </AsyncView>
    </Stack>
  );
}
