// Персонал заведения (блок 5): сотрудники места, которые обрабатывают заявки гостей; назначение по Telegram
// id или username (пользователь уже входил в Mini App) и снятие. До кабинета партнёра (блок 6) это делает админ.
import { useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import {
  ErrorBox,
  Field,
  Form,
  Loaded,
  Notice,
  SelectField,
  SmallButton,
  Table,
  Td,
  useAdmin,
  useBusy,
  useLoad,
} from "./ui.js";
import { formatDate } from "./dates.js";

type Member = ApiSchemas["PlaceStaffMemberDto"];
const ROLES = ["ORG_STAFF", "ORG_OWNER"] as const;
type Role = (typeof ROLES)[number];

const TG_ID = /^[1-9][0-9]{0,19}$/;
const TG_USERNAME = /^@?[A-Za-z0-9_]{5,32}$/;

/** Что ввёл админ → тело назначения или null, если значение некорректно. */
export function staffBody(by: "id" | "username", value: string, role: Role) {
  const v = value.trim();
  if (by === "id") return TG_ID.test(v) ? { telegramUserId: v, role } : null;
  return TG_USERNAME.test(v) ? { username: v.replace(/^@/, ""), role } : null;
}

function memberName(m: Member): string {
  return [m.firstName, m.username ? `@${m.username}` : null, m.telegramUserId]
    .filter((x): x is string => !!x)
    .join(" · ");
}

export function PlaceStaff({ placeId, hostCapable }: { placeId: string; hostCapable: boolean }) {
  const { api } = useAdmin();
  const { t, tDynamic, locale } = useT();
  const [acting, act] = useBusy();
  const [result, reload] = useLoad(
    () => call(api.GET("/admin/places/{id}/staff", { params: { path: { id: placeId } } })),
    [placeId],
  );
  const [by, setBy] = useState<"id" | "username">("id");
  const [value, setValue] = useState("");
  const [role, setRole] = useState<Role>("ORG_STAFF");
  const [error, setError] = useState<ApiError | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const assign = async () => {
    setNotice(null);
    const body = staffBody(by, value, role);
    if (!body) {
      setError(null);
      return setLocal(t("admin.staff.valueInvalid"));
    }
    setLocal(null);
    const res = await call(api.POST("/admin/places/{id}/staff", { params: { path: { id: placeId } }, body }));
    if (!res.ok) return setError(res.error);
    setError(null);
    setValue("");
    setNotice(t("admin.saved"));
    reload();
  };

  const revoke = async (m: Member) => {
    if (!window.confirm(t("admin.staff.revokeConfirm", { name: memberName(m) }))) return;
    setNotice(null);
    const res = await call(
      api.DELETE("/admin/places/{id}/staff/{assignmentId}", {
        params: { path: { id: placeId, assignmentId: m.assignmentId } },
      }),
    );
    if (!res.ok) return setListError(res.error);
    setListError(null);
    setNotice(t("admin.deleted"));
    reload();
  };

  // 403 — нет права назначать персонал: секции нет. Форма назначения — только если список загрузился.
  if (result && !result.ok && result.error.status === 403) return null;
  // Не готель: секция нужна, пока остались назначенные (категорию сменили) — чтобы их можно было снять; при ошибке
  // загрузки (иначе назначенных не увидеть) и до ухода со страницы после снятия последнего (сообщение «Видалено»).
  const keep = (result && !result.ok) || (result?.ok && result.data.items.length > 0) || notice !== null;
  if (!hostCapable && !keep) return null;
  return (
    <section aria-labelledby="place-staff">
      <Stack gap={2}>
        <h2 id="place-staff" style={{ margin: 0 }}>
          {t("admin.staff")}
        </h2>
        <p style={{ margin: 0 }}>{t("admin.staff.hint")}</p>
        <ErrorBox error={listError} />
        <Loaded result={result}>
          {(data) =>
            data.items.length === 0 ? (
              <p style={{ margin: 0 }}>{t("admin.staff.empty")}</p>
            ) : (
              <Table
                caption={t("admin.staff")}
                head={[
                  t("admin.staff.name"),
                  t("admin.staff.role"),
                  t("admin.staff.notifications"),
                  t("admin.staff.granted"),
                  t("admin.actions"),
                ]}
              >
                {data.items.map((m) => (
                  <tr key={m.assignmentId}>
                    <Td>{memberName(m)}</Td>
                    <Td>{tDynamic(`admin.staff.role.${m.role}`)}</Td>
                    <Td>{m.notificationsEnabled ? t("admin.yes") : t("admin.no")}</Td>
                    <Td>{formatDate(m.grantedAt, locale)}</Td>
                    <Td>
                      <SmallButton
                        aria-label={`${t("admin.staff.revoke")}: ${memberName(m)}`}
                        disabled={acting}
                        onClick={() => act(() => revoke(m))}
                      >
                        {t("admin.staff.revoke")}
                      </SmallButton>
                    </Td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Loaded>
        {hostCapable && result?.ok && (
          <Form
            label={t("admin.staff.assign")}
            onSubmit={assign}
            submitLabel={t("admin.staff.assign")}
            error={error}
          >
            <SelectField
              label={t("admin.staff.by")}
              value={by}
              options={[
                { value: "id", label: t("admin.staff.byId") },
                { value: "username", label: t("admin.staff.byUsername") },
              ]}
              onChange={(v) => setBy(v as "id" | "username")}
            />
            <Field label={t("admin.staff.value")} value={value} required onChange={setValue} />
            <SelectField
              label={t("admin.staff.role")}
              value={role}
              options={ROLES.map((r) => ({ value: r, label: tDynamic(`admin.staff.role.${r}`) }))}
              onChange={(v) => setRole(v as Role)}
            />
            {local && <p role="alert">{local}</p>}
          </Form>
        )}
        <Notice text={notice} />
      </Stack>
    </section>
  );
}
