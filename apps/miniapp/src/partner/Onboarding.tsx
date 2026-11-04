// P12 «Стати партнером» (S-05): шаблон (GET /partner/templates) → категория и название → POST /partner/onboarding
// → редактор P06 нового черновика. Статус модерации и отправка — в P06.
import { useEffect, useId, useRef, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Stack, useRoute, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { AsyncView, card, listStyle } from "../guide/parts.js";
import { useErrorText } from "../host/errors.js";
import { usePartner } from "./context.js";
import { keepsIdempotencyKey } from "./partner-api.js";
import { Live, newKey, type Message } from "./parts.js";

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
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  // Один ключ на попытку создания: повтор после сбоя сети не создаст второе заведение.
  // Сервер хранит ответ по ключу (и 4xx): после окончательной ошибки или правки формы — новый ключ.
  const key = useRef(newKey());
  useEffect(() => {
    key.current = newKey();
  }, [code, categoryId, name, orgName]);
  const ids = { category: useId(), name: useId(), org: useId() };
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;

  return (
    <Stack>
      <h1>{t("miniapp.partner.become")}</h1>
      <p>{t("miniapp.partner.onboarding.intro")}</p>
      <AsyncView state={templates} retry={retry} errorText={t("miniapp.partner.loadError")}>
        {(items) => {
          const available = items.filter((x) => x.categories.length > 0);
          if (!available.length) return <p>{t("miniapp.partner.onboarding.noTemplates")}</p>;
          const template = available.find((x) => x.code === code) ?? null;
          const create = async () => {
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
                  ...(orgName.trim() ? { organizationName: orgName.trim() } : {}),
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
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend>{t("miniapp.partner.onboarding.template")}</legend>
                <ul style={listStyle}>
                  {available.map((x) => (
                    <li key={x.id} style={card}>
                      <label>
                        <input
                          type="radio"
                          name="template"
                          value={x.code}
                          checked={code === x.code}
                          onChange={() => {
                            setCode(x.code);
                            setCategoryId(x.categories.length === 1 ? x.categories[0]!.id : "");
                          }}
                        />{" "}
                        <strong>{pickLocalized(x.name, locale)}</strong>
                      </label>
                      {x.description && (
                        <p style={{ margin: "4px 0 0" }}>{pickLocalized(x.description, locale)}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </fieldset>
              {template && (
                <label htmlFor={ids.category}>
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
              <label htmlFor={ids.name}>
                {t("miniapp.partner.onboarding.name")}
                <input id={ids.name} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </label>
              <label htmlFor={ids.org}>
                {t("miniapp.partner.onboarding.orgName")}
                <input
                  id={ids.org}
                  value={orgName}
                  maxLength={200}
                  onChange={(e) => setOrgName(e.target.value)}
                />
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
