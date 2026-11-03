// Сценарии «Мій план» (блок 5, C09, D-53): готовые маршруты региона по дням — список со статусами,
// редактор (название, описание, теги, сезоны, пункты по дням с местом и альтернативами), публикация. Список —
// с фильтром по сезону, тегу и статусу (сценариев 100–200: генератор scenarios:generate).
import { useEffect, useState } from "react";
import { Link, Stack, useRoute, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas, type Result } from "./api.js";
import {
  CheckboxField,
  emptyLocalized,
  ErrorBox,
  Field,
  fromLocalized,
  Form,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  SelectField,
  SmallButton,
  Table,
  Td,
  toLocalized,
  useAdmin,
  useBusy,
  useLoad,
  useLocalized,
  type LocalizedValue,
} from "./ui.js";

type Summary = ApiSchemas["AdminScenarioDto"];
type Detail = ApiSchemas["AdminScenarioDetailDto"];
type Status = Summary["status"];
type Tag = Summary["tags"][number];
type Season = Summary["seasons"][number];
type AdLabel = NonNullable<Summary["adLabel"]>;
type Body = ApiSchemas["ScenarioInputDto"];

export const SCENARIO_TAGS = [
  "one_day",
  "multi_day",
  "kids",
  "rain",
  "no_car",
  "romantic",
  "active",
  "budget",
  "premium",
  "hiking",
  "mountains",
  "waterfalls",
  "culture",
  "gastro",
  "relax",
  "ski",
  "excursion",
] as const satisfies readonly Tag[];
export const SCENARIO_SEASONS = ["winter", "spring", "summer", "autumn"] as const satisfies readonly Season[];
const AD_LABELS = ["advertising", "partner"] as const satisfies readonly AdLabel[];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

type ItemForm = {
  dayNo: number;
  placeId: string;
  timeHint: string;
  duration: string;
  note: LocalizedValue;
  alternatives: string[];
};
type ScenarioForm = {
  code: string;
  title: LocalizedValue;
  description: LocalizedValue;
  days: string;
  tags: Tag[];
  seasons: Season[];
  adLabel: string;
  sortOrder: string;
  items: ItemForm[];
};

const emptyForm = (): ScenarioForm => ({
  code: "",
  title: emptyLocalized(),
  description: emptyLocalized(),
  days: "1",
  tags: [],
  seasons: [],
  adLabel: "",
  sortOrder: "0",
  items: [],
});

function toForm(s: Detail): ScenarioForm {
  return {
    code: s.code,
    title: fromLocalized(s.title),
    description: fromLocalized(s.description),
    days: String(s.days),
    tags: s.tags,
    seasons: s.seasons ?? [],
    adLabel: s.adLabel ?? "",
    sortOrder: String(s.sortOrder),
    items: [...s.items]
      .sort((a, b) => a.dayNo - b.dayNo || a.position - b.position)
      .map((i) => ({
        dayNo: i.dayNo,
        placeId: i.placeId,
        timeHint: i.timeHint ?? "",
        duration: i.durationMin === null ? "" : String(i.durationMin),
        note: fromLocalized(i.note),
        alternatives: i.alternatives,
      })),
  };
}

/** Проблема формы до отправки: ключ сообщения или null. Пункты вне числа дней отбрасываются. */
export function scenarioProblem(
  f: ScenarioForm,
): "admin.scenario.itemsRequired" | "admin.scenario.placeRequired" | null {
  const items = f.items.filter((i) => i.dayNo <= Number(f.days));
  if (items.length === 0) return "admin.scenario.itemsRequired";
  if (items.some((i) => !i.placeId || i.alternatives.some((a) => !a))) return "admin.scenario.placeRequired";
  return null;
}

export function scenarioBody(f: ScenarioForm): Body {
  const days = Number(f.days);
  const sort = Number(f.sortOrder);
  return {
    code: f.code.trim(),
    title: toLocalized(f.title) ?? { uk: "" },
    description: toLocalized(f.description),
    days,
    tags: f.tags,
    seasons: SCENARIO_SEASONS.filter((x) => f.seasons.includes(x)),
    adLabel: (f.adLabel || null) as Body["adLabel"],
    sortOrder: Number.isFinite(sort) ? sort : 0,
    items: f.items
      .filter((i) => i.dayNo <= days)
      .map((i) => ({
        dayNo: i.dayNo,
        placeId: i.placeId,
        timeHint: HHMM.test(i.timeHint.trim()) ? i.timeHint.trim() : null,
        durationMin: i.duration.trim() === "" ? null : Number(i.duration),
        note: toLocalized(i.note),
        alternatives: [...new Set(i.alternatives.filter(Boolean))],
      })),
  };
}

/** Все места региона для выбора (страницы курсора, не больше 10). */
function useAllPlaces() {
  const { api } = useAdmin();
  const l = useLocalized();
  const [places, setPlaces] = useState<{ value: string; label: string }[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const all: ApiSchemas["PlaceDto"][] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: Result<{ items: ApiSchemas["PlaceDto"][]; nextCursor: string | null }> = await call(
          api.GET("/admin/places", { params: { query: cursor ? { cursor } : {} } }),
        );
        if (!res.ok) {
          if (alive) setError(res.error);
          break;
        }
        all.push(...res.data.items);
        cursor = res.data.nextCursor;
        if (!cursor) break;
      }
      if (alive) setPlaces(all.map((p) => ({ value: p.id, label: l(p.name) })));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return { places, error };
}

const STATUS_ACTIONS: Record<
  Status,
  { to: Status; label: "admin.scenario.publish" | "admin.scenario.unpublish" | "admin.scenario.archive" }[]
> = {
  draft: [
    { to: "published", label: "admin.scenario.publish" },
    { to: "archived", label: "admin.scenario.archive" },
  ],
  published: [
    { to: "draft", label: "admin.scenario.unpublish" },
    { to: "archived", label: "admin.scenario.archive" },
  ],
  archived: [{ to: "draft", label: "admin.scenario.unpublish" }],
};

export function ScenarioStatusButtons({
  scenario,
  onChanged,
  onError,
}: {
  scenario: Pick<Summary, "id" | "status" | "code">;
  onChanged: (s: Status) => void;
  onError: (e: ApiError | null) => void;
}) {
  const { api } = useAdmin();
  const { t } = useT();
  const [acting, act] = useBusy();
  const change = async (status: Status) => {
    const res = await call(
      api.PATCH("/admin/scenarios/{id}/status", { params: { path: { id: scenario.id } }, body: { status } }),
    );
    if (!res.ok) return onError(res.error);
    onError(null);
    onChanged(status);
  };
  return (
    <>
      {STATUS_ACTIONS[scenario.status].map((a) => (
        <SmallButton
          key={a.to}
          disabled={acting}
          aria-label={`${t(a.label)}: ${scenario.code}`}
          onClick={() => act(() => change(a.to))}
        >
          {t(a.label)}
        </SmallButton>
      ))}
    </>
  );
}

/** Сезоны сценария для таблицы: «Зима, Літо» или «Круглий рік». */
export function seasonsLabel(seasons: readonly Season[], tDynamic: (key: string) => string, allYear: string) {
  return seasons.length ? seasons.map((x) => tDynamic(`admin.scenario.season.${x}`)).join(", ") : allYear;
}

function ScenarioList() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const [season, setSeason] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("");
  const [result, reload] = useLoad(
    () =>
      call(
        api.GET("/admin/scenarios", {
          params: {
            query: {
              ...(season ? { season: season as Season } : {}),
              ...(tag ? { tag: tag as Tag } : {}),
              ...(status ? { status: status as Status } : {}),
            },
          },
        }),
      ),
    [season, tag, status],
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Stack gap={2}>
      <div>
        <Link to="/scenarios/new">{t("admin.scenario.new")}</Link>
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
        <SelectField
          label={t("admin.scenario.filterSeason")}
          value={season}
          empty={t("admin.scenario.filterAll")}
          options={SCENARIO_SEASONS.map((x) => ({ value: x, label: tDynamic(`admin.scenario.season.${x}`) }))}
          onChange={setSeason}
        />
        <SelectField
          label={t("admin.scenario.filterTag")}
          value={tag}
          empty={t("admin.scenario.filterAll")}
          options={SCENARIO_TAGS.map((x) => ({ value: x, label: tDynamic(`admin.scenario.tag.${x}`) }))}
          onChange={setTag}
        />
        <SelectField
          label={t("admin.scenario.filterStatus")}
          value={status}
          empty={t("admin.scenario.filterAll")}
          options={(["draft", "published", "archived"] as const).map((x) => ({
            value: x,
            label: tDynamic(`admin.scenario.status.${x}`),
          }))}
          onChange={setStatus}
        />
      </div>
      <Notice text={notice} />
      <ErrorBox error={error} />
      <Loaded result={result}>
        {(data) =>
          data.items.length === 0 ? (
            <p>{t("admin.empty")}</p>
          ) : (
            <>
              <p style={{ margin: 0 }}>{t("admin.scenario.shown", { n: data.items.length })}</p>
              <Table
                caption={t("admin.scenarios")}
                head={[
                  t("admin.field.name"),
                  t("admin.field.code"),
                  t("admin.scenario.days"),
                  t("admin.scenario.seasons"),
                  t("admin.scenario.tags"),
                  t("admin.scenario.itemCount"),
                  t("admin.field.status"),
                  t("admin.actions"),
                ]}
              >
                {data.items.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <Link to={`/scenarios/${s.id}`}>{l(s.title)}</Link>
                    </Td>
                    <Td>{s.code}</Td>
                    <Td>{s.days}</Td>
                    <Td>{seasonsLabel(s.seasons ?? [], tDynamic, t("admin.scenario.allYear"))}</Td>
                    <Td>{s.tags.map((x) => tDynamic(`admin.scenario.tag.${x}`)).join(", ")}</Td>
                    <Td>{s.itemCount}</Td>
                    <Td>{tDynamic(`admin.scenario.status.${s.status}`)}</Td>
                    <Td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <ScenarioStatusButtons
                          scenario={s}
                          onError={setError}
                          onChanged={() => {
                            setNotice(t("admin.saved"));
                            reload();
                          }}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </>
          )
        }
      </Loaded>
    </Stack>
  );
}

function PlaceSelect({
  label,
  value,
  places,
  onChange,
  required,
}: {
  label: string;
  value: string;
  places: { value: string; label: string }[];
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const { t } = useT();
  // Выбранное место, которого нет в загруженном списке, не теряем.
  const options =
    value && !places.some((p) => p.value === value)
      ? [...places, { value, label: t("admin.scenario.placeUnknown", { id: value.slice(0, 8) }) }]
      : places;
  return (
    <SelectField
      label={label}
      value={value}
      required={required}
      empty={t("admin.choose")}
      options={options}
      onChange={onChange}
    />
  );
}

function ScenarioEditor({ scenario }: { scenario?: Detail }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [, navigate] = useRoute();
  const { places: loadedPlaces, error: placesError } = useAllPlaces();
  const [current, setCurrent] = useState(scenario);
  const [form, setForm] = useState(() => (scenario ? toForm(scenario) : emptyForm()));
  const [error, setError] = useState<ApiError | null>(null);
  const [statusError, setStatusError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const patch = (p: Partial<ScenarioForm>) => setForm((f) => ({ ...f, ...p }));
  const setItem = (idx: number, p: Partial<ItemForm>) =>
    patch({ items: form.items.map((x, j) => (j === idx ? { ...x, ...p } : x)) });
  const daysNum = Number(form.days);
  const daysValid = form.days.trim() !== "" && Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 5;
  const days = daysValid ? daysNum : 1;
  const dropped = daysValid ? form.items.filter((i) => i.dayNo > daysNum).length : 0;

  const save = async () => {
    setNotice(null);
    const problem = scenarioProblem(form);
    if (problem) {
      setError(null);
      return setLocal(t(problem));
    }
    setLocal(null);
    const body = scenarioBody(form);
    const res = current
      ? await call(api.PUT("/admin/scenarios/{id}", { params: { path: { id: current.id } }, body }))
      : await call(api.POST("/admin/scenarios", { body }));
    if (!res.ok) return setError(res.error);
    setError(null);
    setNotice(t("admin.saved"));
    setCurrent(res.data);
    setForm(toForm(res.data));
    if (!current) navigate(`/scenarios/${res.data.id}`, { replace: true });
  };

  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>
        <Link to="/scenarios">← {t("admin.scenarios")}</Link>
      </p>
      {current && (
        <section
          aria-label={`${t("admin.field.status")}: ${tDynamic(`admin.scenario.status.${current.status}`)}`}
        >
          <Stack gap={2}>
            <h2 style={{ margin: 0 }}>
              {t("admin.field.status")}: {tDynamic(`admin.scenario.status.${current.status}`)} ·{" "}
              {t("admin.scenario.version")} {current.version}
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <ScenarioStatusButtons
                scenario={current}
                onError={setStatusError}
                onChanged={(status) => setCurrent({ ...current, status })}
              />
            </div>
            <ErrorBox error={statusError} />
          </Stack>
        </section>
      )}
      <Form
        label={current ? t("admin.editing") : t("admin.scenario.new")}
        onSubmit={save}
        submitLabel={t("admin.save")}
        error={error}
      >
        <div style={grid2}>
          <Field
            label={t("admin.scenario.code")}
            value={form.code}
            required
            onChange={(code) => patch({ code })}
          />
          <Field
            label={t("admin.scenario.days")}
            type="number"
            value={form.days}
            required
            onChange={(v) => patch({ days: v })}
          />
          {!daysValid && (
            <p role="note" style={{ margin: 0 }}>
              {t("admin.scenario.daysInvalid")}
            </p>
          )}
          {dropped > 0 && (
            <p role="note" style={{ margin: 0 }}>
              {t("admin.scenario.daysDrop", { n: dropped })}
            </p>
          )}
          <SelectField
            label={t("admin.scenario.adLabel")}
            value={form.adLabel}
            empty={t("admin.scenario.adLabel.none")}
            options={AD_LABELS.map((a) => ({ value: a, label: tDynamic(`admin.scenario.adLabel.${a}`) }))}
            onChange={(adLabel) => patch({ adLabel })}
          />
          <Field
            label={t("admin.field.sortOrder")}
            type="number"
            value={form.sortOrder}
            onChange={(sortOrder) => patch({ sortOrder })}
          />
        </div>
        <LocalizedField
          label={t("admin.field.name")}
          value={form.title}
          required
          onChange={(title) => patch({ title })}
        />
        <LocalizedField
          label={t("admin.field.description")}
          value={form.description}
          multiline
          onChange={(description) => patch({ description })}
        />
        <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
          <legend>{t("admin.scenario.tags")}</legend>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {SCENARIO_TAGS.map((tag) => (
              <CheckboxField
                key={tag}
                label={tDynamic(`admin.scenario.tag.${tag}`)}
                checked={form.tags.includes(tag)}
                onChange={(on) =>
                  patch({ tags: on ? [...form.tags, tag] : form.tags.filter((x) => x !== tag) })
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
          <legend>{t("admin.scenario.seasons")}</legend>
          <p style={{ margin: "0 0 8px" }}>{t("admin.scenario.seasonsHint")}</p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {SCENARIO_SEASONS.map((x) => (
              <CheckboxField
                key={x}
                label={tDynamic(`admin.scenario.season.${x}`)}
                checked={form.seasons.includes(x)}
                onChange={(on) =>
                  patch({ seasons: on ? [...form.seasons, x] : form.seasons.filter((y) => y !== x) })
                }
              />
            ))}
          </div>
        </fieldset>

        <h3 style={{ margin: 0 }}>{t("admin.scenario.items")}</h3>
        {Array.from({ length: days }, (_, d) => d + 1).map((day) => {
          const dayItems = form.items.map((x, idx) => ({ x, idx })).filter(({ x }) => x.dayNo === day);
          return (
            <fieldset key={day} style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
              <legend>{t("admin.scenario.day", { n: day })}</legend>
              <Stack gap={2}>
                {dayItems.length === 0 && <p style={{ margin: 0 }}>{t("admin.scenario.dayEmpty")}</p>}
                {dayItems.map(({ x, idx }, pos) => {
                  const n = `${day}.${pos + 1}`;
                  return (
                    <fieldset key={idx} style={{ border: "1px dashed #c4c7cc", borderRadius: 6, margin: 0 }}>
                      <legend>{t("admin.scenario.item", { n })}</legend>
                      <Stack gap={2}>
                        <div style={grid2}>
                          <PlaceSelect
                            label={`${t("admin.scenario.place")} ${n}`}
                            value={x.placeId}
                            places={loadedPlaces}
                            onChange={(placeId) => setItem(idx, { placeId })}
                          />
                          <Field
                            label={`${t("admin.scenario.timeHint")} ${n}`}
                            type="time"
                            value={x.timeHint}
                            onChange={(timeHint) => setItem(idx, { timeHint })}
                          />
                          <Field
                            label={`${t("admin.scenario.duration")} ${n}`}
                            type="number"
                            value={x.duration}
                            onChange={(duration) => setItem(idx, { duration })}
                          />
                        </div>
                        <LocalizedField
                          label={`${t("admin.scenario.note")} ${n}`}
                          value={x.note}
                          multiline
                          onChange={(note) => setItem(idx, { note })}
                        />
                        <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
                          <legend>
                            {t("admin.scenario.alternatives")} {n}
                          </legend>
                          <Stack gap={2}>
                            {x.alternatives.map((alt, k) => (
                              <div key={k} style={{ display: "flex", gap: 8, alignItems: "end" }}>
                                <PlaceSelect
                                  label={`${t("admin.scenario.alternatives")} ${n}.${k + 1}`}
                                  value={alt}
                                  places={loadedPlaces}
                                  onChange={(v) =>
                                    setItem(idx, {
                                      alternatives: x.alternatives.map((a, m) => (m === k ? v : a)),
                                    })
                                  }
                                />
                                <SmallButton
                                  aria-label={`${t("admin.scenario.removeAlternative")} ${n}.${k + 1}`}
                                  onClick={() =>
                                    setItem(idx, { alternatives: x.alternatives.filter((_, m) => m !== k) })
                                  }
                                >
                                  {t("admin.scenario.removeAlternative")}
                                </SmallButton>
                              </div>
                            ))}
                            <div>
                              <SmallButton
                                aria-label={`${t("admin.scenario.addAlternative")} ${n}`}
                                onClick={() => setItem(idx, { alternatives: [...x.alternatives, ""] })}
                              >
                                {t("admin.scenario.addAlternative")}
                              </SmallButton>
                            </div>
                          </Stack>
                        </fieldset>
                        <div>
                          <SmallButton
                            aria-label={`${t("admin.scenario.removeItem")} ${n}`}
                            onClick={() => patch({ items: form.items.filter((_, j) => j !== idx) })}
                          >
                            {t("admin.scenario.removeItem")}
                          </SmallButton>
                        </div>
                      </Stack>
                    </fieldset>
                  );
                })}
                <div>
                  <SmallButton
                    aria-label={`${t("admin.scenario.addItem")}: ${t("admin.scenario.day", { n: day })}`}
                    onClick={() =>
                      patch({
                        items: [
                          ...form.items,
                          {
                            dayNo: day,
                            placeId: "",
                            timeHint: "",
                            duration: "",
                            note: emptyLocalized(),
                            alternatives: [],
                          },
                        ],
                      })
                    }
                  >
                    {t("admin.scenario.addItem")}
                  </SmallButton>
                </div>
              </Stack>
            </fieldset>
          );
        })}
        <ErrorBox error={placesError} />
        {local && <p role="alert">{local}</p>}
        <Notice text={notice} />
      </Form>
    </Stack>
  );
}

function ScenarioEditorScreen({ id }: { id: string | null }) {
  const { api } = useAdmin();
  const [result] = useLoad(
    () =>
      id
        ? call(api.GET("/admin/scenarios/{id}", { params: { path: { id } } }))
        : Promise.resolve({ ok: true as const, data: undefined }),
    [id],
  );
  return <Loaded result={result}>{(s) => <ScenarioEditor key={s?.id ?? "new"} scenario={s} />}</Loaded>;
}

/** Раздел «Сценарії»: `/scenarios`, `/scenarios/new`, `/scenarios/<id>`. */
export function ScenariosScreen({ id }: { id?: string }) {
  if (!id) return <ScenarioList />;
  return <ScenarioEditorScreen id={id === "new" ? null : id} />;
}
