// Модуль готелю места (блок 5, C03): Wi-Fi, телефон рецепции, часы приёма, разделы («Про заклад», правила),
// услуги с SLA в минутах. PUT заменяет настройки целиком; пароль Wi-Fi хранит и отдаёт api только админу.
import { useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import {
  CheckboxField,
  emptyLocalized,
  Field,
  fromLocalized,
  Form,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  row,
  SelectField,
  SmallButton,
  toLocalized,
  useAdmin,
  useLoad,
  type LocalizedValue,
} from "./ui.js";

type HostModule = ApiSchemas["AdminHostModuleDto"];
type PutBody = ApiSchemas["PutHostModuleDto"];

export const SECTION_KINDS = [
  "rules",
  "contacts",
  "breakfast",
  "checkout",
  "pool",
  "transfer",
  "custom",
] as const;
type SectionKind = (typeof SECTION_KINDS)[number];

type SectionForm = { kind: SectionKind; title: LocalizedValue; content: LocalizedValue };
type ServiceForm = {
  code: string;
  title: LocalizedValue;
  description: LocalizedValue;
  sla: string;
  enabled: boolean;
};
type HostForm = {
  enabled: boolean;
  wifiSsid: string;
  wifiPassword: string;
  receptionPhone: string;
  hoursFrom: string;
  hoursTo: string;
  sections: SectionForm[];
  services: ServiceForm[];
};

function toForm(m: HostModule): HostForm {
  return {
    enabled: m.enabled,
    wifiSsid: m.wifiSsid ?? "",
    wifiPassword: m.wifiPassword ?? "",
    receptionPhone: m.receptionPhone ?? "",
    hoursFrom: m.hours?.from ?? "",
    hoursTo: m.hours?.to ?? "",
    sections: [...m.sections]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({ kind: s.kind, title: fromLocalized(s.title), content: fromLocalized(s.content) })),
    services: [...m.services]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        code: s.code,
        title: fromLocalized(s.title),
        description: fromLocalized(s.description),
        sla: String(s.slaMinutes),
        enabled: s.enabled,
      })),
  };
}

/** Проверка до отправки: SLA — целое 5–1440, часы приёма — парой. Возвращает ключ сообщения или null. */
export function hostProblem(f: HostForm): "admin.host.slaInvalid" | "admin.host.hoursPair" | null {
  if (!f.hoursFrom !== !f.hoursTo) return "admin.host.hoursPair";
  for (const s of f.services) {
    const n = Number(s.sla);
    if (!Number.isInteger(n) || n < 5 || n > 1440) return "admin.host.slaInvalid";
  }
  return null;
}

export function hostBody(f: HostForm): PutBody {
  const opt = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    enabled: f.enabled,
    wifiSsid: opt(f.wifiSsid),
    wifiPassword: opt(f.wifiPassword),
    receptionPhone: opt(f.receptionPhone),
    hours: f.hoursFrom && f.hoursTo ? { from: f.hoursFrom, to: f.hoursTo } : null,
    sections: f.sections.map((s, i) => ({
      kind: s.kind,
      title: toLocalized(s.title) ?? { uk: "" },
      content: toLocalized(s.content) ?? { uk: "" },
      sortOrder: i,
    })),
    services: f.services.map((s, i) => ({
      code: s.code.trim(),
      title: toLocalized(s.title) ?? { uk: "" },
      description: toLocalized(s.description),
      slaMinutes: Number(s.sla),
      enabled: s.enabled,
      sortOrder: i,
    })),
  };
}

function Editor({ placeId, module }: { placeId: string; module: HostModule }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [form, setForm] = useState(() => toForm(module));
  const [configured, setConfigured] = useState(module.configured);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const patch = (p: Partial<HostForm>) => setForm((f) => ({ ...f, ...p }));
  const setSection = (i: number, p: Partial<SectionForm>) =>
    patch({ sections: form.sections.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setService = (i: number, p: Partial<ServiceForm>) =>
    patch({ services: form.services.map((s, j) => (j === i ? { ...s, ...p } : s)) });

  const save = async () => {
    setNotice(null);
    const problem = hostProblem(form);
    if (problem) {
      setError(null);
      return setLocal(t(problem));
    }
    setLocal(null);
    const res = await call(
      api.PUT("/admin/places/{id}/host-module", { params: { path: { id: placeId } }, body: hostBody(form) }),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setConfigured(res.data.configured);
    setForm(toForm(res.data));
    setNotice(t("admin.saved"));
  };

  return (
    <Form label={t("admin.host")} onSubmit={save} submitLabel={t("admin.host.save")} error={error}>
      <p style={{ margin: 0 }}>{t("admin.host.hint")}</p>
      {!configured && <p style={{ margin: 0 }}>{t("admin.host.notConfigured")}</p>}
      <CheckboxField
        label={t("admin.host.enabled")}
        checked={form.enabled}
        onChange={(enabled) => patch({ enabled })}
      />
      <div style={grid2}>
        <Field
          label={t("admin.host.wifiSsid")}
          value={form.wifiSsid}
          maxLength={64}
          onChange={(wifiSsid) => patch({ wifiSsid })}
        />
        <Field
          label={t("admin.host.wifiPassword")}
          value={form.wifiPassword}
          maxLength={128}
          onChange={(wifiPassword) => patch({ wifiPassword })}
        />
        <Field
          label={t("admin.host.receptionPhone")}
          type="tel"
          value={form.receptionPhone}
          onChange={(receptionPhone) => patch({ receptionPhone })}
        />
      </div>
      <div style={row}>
        <Field
          label={t("admin.host.hoursFrom")}
          type="time"
          value={form.hoursFrom}
          onChange={(hoursFrom) => patch({ hoursFrom })}
        />
        <Field
          label={t("admin.host.hoursTo")}
          type="time"
          value={form.hoursTo}
          onChange={(hoursTo) => patch({ hoursTo })}
        />
      </div>
      <p style={{ margin: 0 }}>{t("admin.host.hoursHint")}</p>

      <Stack gap={2}>
        <h3 style={{ margin: 0 }}>{t("admin.host.sections")}</h3>
        {form.sections.map((s, i) => (
          <fieldset key={i} style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
            <legend>
              {t("admin.host.section")} {i + 1}
            </legend>
            <Stack gap={2}>
              <SelectField
                label={`${t("admin.host.sectionKind")} ${i + 1}`}
                value={s.kind}
                options={SECTION_KINDS.map((k) => ({
                  value: k,
                  label: tDynamic(`admin.host.sectionKind.${k}`),
                }))}
                onChange={(kind) => setSection(i, { kind: kind as SectionKind })}
              />
              <LocalizedField
                label={`${t("admin.host.sectionTitle")} ${i + 1}`}
                value={s.title}
                required
                onChange={(title) => setSection(i, { title })}
              />
              <LocalizedField
                label={`${t("admin.host.sectionContent")} ${i + 1}`}
                value={s.content}
                required
                multiline
                onChange={(content) => setSection(i, { content })}
              />
              <div>
                <SmallButton
                  aria-label={`${t("admin.host.removeSection")} ${i + 1}`}
                  onClick={() => patch({ sections: form.sections.filter((_, j) => j !== i) })}
                >
                  {t("admin.host.removeSection")}
                </SmallButton>
              </div>
            </Stack>
          </fieldset>
        ))}
        <div>
          <SmallButton
            onClick={() =>
              patch({
                sections: [
                  ...form.sections,
                  { kind: "rules", title: emptyLocalized(), content: emptyLocalized() },
                ],
              })
            }
          >
            {t("admin.host.addSection")}
          </SmallButton>
        </div>
      </Stack>

      <Stack gap={2}>
        <h3 style={{ margin: 0 }}>{t("admin.host.services")}</h3>
        {form.services.map((s, i) => (
          <fieldset key={i} style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
            <legend>
              {t("admin.host.service")} {i + 1}
            </legend>
            <Stack gap={2}>
              <div style={grid2}>
                <Field
                  label={`${t("admin.host.serviceCode")} ${i + 1}`}
                  value={s.code}
                  required
                  onChange={(code) => setService(i, { code })}
                />
                <Field
                  label={`${t("admin.host.serviceSla")} ${i + 1}`}
                  type="number"
                  value={s.sla}
                  required
                  onChange={(sla) => setService(i, { sla })}
                />
              </div>
              <LocalizedField
                label={`${t("admin.host.serviceTitle")} ${i + 1}`}
                value={s.title}
                required
                onChange={(title) => setService(i, { title })}
              />
              <LocalizedField
                label={`${t("admin.host.serviceDescription")} ${i + 1}`}
                value={s.description}
                multiline
                onChange={(description) => setService(i, { description })}
              />
              <CheckboxField
                label={`${t("admin.host.serviceEnabled")} (${i + 1})`}
                checked={s.enabled}
                onChange={(enabled) => setService(i, { enabled })}
              />
              <div>
                <SmallButton
                  aria-label={`${t("admin.host.removeService")} ${i + 1}`}
                  onClick={() => patch({ services: form.services.filter((_, j) => j !== i) })}
                >
                  {t("admin.host.removeService")}
                </SmallButton>
              </div>
            </Stack>
          </fieldset>
        ))}
        <div>
          <SmallButton
            onClick={() =>
              patch({
                services: [
                  ...form.services,
                  {
                    code: "",
                    title: emptyLocalized(),
                    description: emptyLocalized(),
                    sla: "60",
                    enabled: true,
                  },
                ],
              })
            }
          >
            {t("admin.host.addService")}
          </SmallButton>
        </div>
      </Stack>
      {local && <p role="alert">{local}</p>}
      <Notice text={notice} />
    </Form>
  );
}

/** Секция «Модуль готелю» в карточке места: GET/PUT /admin/places/{id}/host-module. */
export function PlaceHostModule({ placeId }: { placeId: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result] = useLoad(
    () => call(api.GET("/admin/places/{id}/host-module", { params: { path: { id: placeId } } })),
    [placeId],
  );
  // Нет права на модуль (например, модератор каталога) — секцию не показываем, без красных ошибок.
  if (result && !result.ok && result.error.status === 403) return null;
  return (
    <section aria-labelledby="place-host">
      <Stack gap={2}>
        <h2 id="place-host" style={{ margin: 0 }}>
          {t("admin.host")}
        </h2>
        <Loaded result={result}>{(m) => <Editor placeId={placeId} module={m} />}</Loaded>
      </Stack>
    </section>
  );
}
