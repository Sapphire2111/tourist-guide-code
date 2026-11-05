// Недельный график места: интервалы по дням (ISO 1–7, местное время региона). PUT заменяет график целиком,
// исключения по датам сохраняются как загружены (их правка — позже).
import { useEffect, useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { ErrorBox, Field, Loaded, Notice, row, SmallButton, useAdmin, useLoad, useBusy } from "./ui.js";

type Schedule = ApiSchemas["ScheduleDto"];
type Interval = { dayOfWeek: number; opensAt: string; closesAt: string };
export const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function Editor({ placeId, schedule }: { placeId: string; schedule: Schedule }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [acting, act] = useBusy();
  const [weekly, setWeekly] = useState<Interval[]>(schedule.weekly);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setWeekly(schedule.weekly), [schedule]);

  const update = (i: number, patch: Partial<Interval>) =>
    setWeekly((w) => w.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    setNotice(null);
    const exceptions = schedule.exceptions.map((e) => ({
      date: e.date,
      closed: e.closed,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
      note: e.note,
    }));
    const res = await call(
      api.PUT("/admin/places/{id}/schedule", {
        params: { path: { id: placeId } },
        body: { weekly: [...weekly].sort((a, b) => a.dayOfWeek - b.dayOfWeek), exceptions },
      }),
    );
    if (!res.ok) return setError(res.error);
    setError(null);
    setWeekly(res.data.weekly);
    setNotice(t("admin.saved"));
  };

  return (
    <Stack gap={2}>
      <p style={{ margin: 0 }}>{t("admin.schedule.hint", { timezone: schedule.timezone })}</p>
      {DAYS.map((day) => {
        const dayName = tDynamic(`common.weekday.${day}`);
        const items = weekly.map((x, i) => ({ x, i })).filter(({ x }) => x.dayOfWeek === day);
        return (
          <fieldset key={day} style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
            <legend>{dayName}</legend>
            <Stack gap={1}>
              {items.length === 0 && <p style={{ margin: 0 }}>{t("admin.schedule.closed")}</p>}
              {items.map(({ x, i }) => (
                <div key={i} style={row}>
                  <Field
                    label={t("admin.schedule.opens")}
                    type="time"
                    value={x.opensAt}
                    onChange={(opensAt) => update(i, { opensAt })}
                  />
                  <Field
                    label={t("admin.schedule.closes")}
                    type="time"
                    value={x.closesAt}
                    onChange={(closesAt) => update(i, { closesAt })}
                  />
                  <SmallButton
                    aria-label={`${t("admin.schedule.remove")}: ${dayName}`}
                    onClick={() => setWeekly((w) => w.filter((_, j) => j !== i))}
                  >
                    {t("admin.schedule.remove")}
                  </SmallButton>
                </div>
              ))}
              <div>
                <SmallButton
                  aria-label={`${t("admin.schedule.add")}: ${dayName}`}
                  onClick={() =>
                    setWeekly((w) => [...w, { dayOfWeek: day, opensAt: "09:00", closesAt: "18:00" }])
                  }
                >
                  {t("admin.schedule.add")}
                </SmallButton>
              </div>
            </Stack>
          </fieldset>
        );
      })}
      <ErrorBox error={error} />
      <div>
        <SmallButton disabled={acting} onClick={() => act(() => save())}>
          {t("admin.schedule.save")}
        </SmallButton>
      </div>
      <Notice text={notice} />
    </Stack>
  );
}

export function PlaceSchedule({ placeId }: { placeId: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result] = useLoad(
    () => call(api.GET("/admin/places/{id}/schedule", { params: { path: { id: placeId } } })),
    [placeId],
  );
  return (
    <section aria-labelledby="place-schedule">
      <Stack gap={2}>
        <h2 id="place-schedule" style={{ margin: 0 }}>
          {t("admin.schedule")}
        </h2>
        <Loaded result={result}>{(s) => <Editor placeId={placeId} schedule={s} />}</Loaded>
      </Stack>
    </section>
  );
}
