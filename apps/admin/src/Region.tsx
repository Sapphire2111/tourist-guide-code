// Настройки региона (AD07): название, таймзона, язык по умолчанию. Регион — текущий регион сессии.
import { useEffect, useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, grantRegions, type ApiError, type ApiSchemas } from "./api.js";
import {
  Field,
  Form,
  fromLocalized,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  Table,
  Td,
  toLocalized,
  useAdmin,
  useLoad,
  useLocalized,
  type LocalizedValue,
} from "./ui.js";

type Region = ApiSchemas["RegionDto"];

function RegionForm({ region, onSaved }: { region: Region; onSaved: () => void }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [name, setName] = useState<LocalizedValue>(fromLocalized(region.name));
  const [timezone, setTimezone] = useState(region.timezone);
  const [language, setLanguage] = useState(region.defaultLanguage);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setName(fromLocalized(region.name));
    setTimezone(region.timezone);
    setLanguage(region.defaultLanguage);
  }, [region]);
  const save = async () => {
    setNotice(null);
    const res = await call(
      api.PATCH("/admin/regions/{id}", {
        params: { path: { id: region.id } },
        body: { name: toLocalized(name) ?? undefined, timezone, defaultLanguage: language },
      }),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setNotice(t("admin.saved"));
    onSaved();
  };
  return (
    <Form label={t("admin.region.settings")} onSubmit={save} submitLabel={t("admin.save")} error={error}>
      <LocalizedField label={t("admin.field.name")} value={name} onChange={setName} required />
      <div style={grid2}>
        <Field label={t("admin.field.timezone")} value={timezone} onChange={setTimezone} required />
        <Field label={t("admin.field.language")} value={language} onChange={setLanguage} required />
      </div>
      <Notice text={notice} />
    </Form>
  );
}

export function RegionScreen() {
  const { api, session } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const [result, reload] = useLoad(() => call(api.GET("/admin/regions")), []);
  const currentId = session.activeRegionId ?? grantRegions(session)[0] ?? null;
  return (
    <Stack gap={3}>
      <Loaded result={result}>
        {(data) => {
          const current = data.items.find((r) => r.id === currentId);
          return (
            <>
              <Table
                caption={t("admin.regions")}
                head={[t("admin.field.code"), t("admin.field.name"), t("admin.field.status")]}
              >
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <Td>{r.code}</Td>
                    <Td>{l(r.name)}</Td>
                    <Td>{tDynamic(`admin.regionStatus.${r.status}`)}</Td>
                  </tr>
                ))}
              </Table>
              <h2 style={{ margin: 0 }}>{t("admin.region.settings")}</h2>
              {current ? <RegionForm region={current} onSaved={reload} /> : <p>{t("admin.region.choose")}</p>}
            </>
          );
        }}
      </Loaded>
    </Stack>
  );
}
