// Справочник «список + форма создания/правки + удаление» по описанию полей (населённые пункты, категории, теги,
// экстренные контакты). Тело запроса и значения формы строит экран (toBody / fromItem).
import { useState, type ReactNode } from "react";
import type { MessageKey } from "@tg/i18n";
import { Stack, useT } from "@tg/ui";
import type { ApiError, Result } from "./api.js";
import {
  CheckboxField,
  ErrorBox,
  Field,
  Form,
  grid2,
  Loaded,
  LocalizedField,
  Notice,
  SelectField,
  SmallButton,
  Table,
  Td,
  useLoad,
  type LocalizedValue,
  useBusy,
} from "./ui.js";

export type FieldDef =
  | { key: string; label: MessageKey; kind: "text" | "number"; required?: boolean; step?: string }
  | { key: string; label: MessageKey; kind: "checkbox" }
  | { key: string; label: MessageKey; kind: "localized"; required?: boolean; multiline?: boolean }
  | {
      key: string;
      label: MessageKey;
      kind: "select";
      options: { value: string; label: string }[];
      required?: boolean;
      empty?: string;
    };

export type FormValues = Record<string, string | boolean | LocalizedValue>;

export type CrudProps<T extends { id: string }, B> = {
  /** Заголовок секции (h2). */
  title: MessageKey;
  load: () => Promise<Result<{ items: T[] }>>;
  create: (body: B) => Promise<Result<unknown>>;
  update: (id: string, body: B) => Promise<Result<unknown>>;
  remove?: (id: string) => Promise<Result<unknown>>;
  /** Поля формы; функция — от id редактируемой записи (null — создание). */
  fields: FieldDef[] | ((editing: string | null) => FieldDef[]);
  /** После успешного создания/правки/удаления (например, перезагрузить зависимый список). */
  onChanged?: () => void;
  empty: () => FormValues;
  fromItem: (item: T) => FormValues;
  toBody: (values: FormValues) => B;
  columns: { label: MessageKey; render: (item: T) => ReactNode }[];
  /** Подпись записи для кнопок («Редагувати X»). */
  itemLabel: (item: T) => string;
};

export function FormFields({
  fields,
  values,
  set,
}: {
  fields: FieldDef[];
  values: FormValues;
  set: (key: string, v: FormValues[string]) => void;
}) {
  const { t } = useT();
  return (
    <div style={grid2}>
      {fields.map((f) => {
        const v = values[f.key];
        switch (f.kind) {
          case "checkbox":
            return (
              <CheckboxField
                key={f.key}
                label={t(f.label)}
                checked={v === true}
                onChange={(x) => set(f.key, x)}
              />
            );
          case "localized":
            return (
              <div key={f.key} style={{ gridColumn: "1 / -1" }}>
                <LocalizedField
                  label={t(f.label)}
                  value={v as LocalizedValue}
                  required={f.required}
                  multiline={f.multiline}
                  onChange={(x) => set(f.key, x)}
                />
              </div>
            );
          case "select":
            return (
              <SelectField
                key={f.key}
                label={t(f.label)}
                value={v as string}
                options={f.options}
                empty={f.empty}
                required={f.required}
                onChange={(x) => set(f.key, x)}
              />
            );
          default:
            return (
              <Field
                key={f.key}
                label={t(f.label)}
                type={f.kind}
                step={f.step}
                value={v as string}
                required={f.required}
                onChange={(x) => set(f.key, x)}
              />
            );
        }
      })}
    </div>
  );
}

export function CrudSection<T extends { id: string }, B>(props: CrudProps<T, B>) {
  const { t } = useT();
  const [acting, act] = useBusy();
  const [result, reload] = useLoad(props.load, []);
  const [editing, setEditing] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>(props.empty);
  const [error, setError] = useState<ApiError | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setEditing(null);
    setValues(props.empty());
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    const body = props.toBody(values);
    const res = editing ? await props.update(editing, body) : await props.create(body);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    reset();
    setNotice(t("admin.saved"));
    reload();
    props.onChanged?.();
  };

  const remove = async (id: string) => {
    if (!props.remove) return;
    setListError(null);
    const res = await props.remove(id);
    if (!res.ok) return setListError(res.error);
    if (editing === id) reset();
    setNotice(t("admin.deleted"));
    reload();
    props.onChanged?.();
  };

  return (
    <section aria-label={t(props.title)}>
      <Stack gap={2}>
        <h2 style={{ margin: 0 }}>{t(props.title)}</h2>
        <Notice text={notice} />
        <ErrorBox error={listError} />
        <Loaded result={result}>
          {(data) => (
            <Table
              caption={t(props.title)}
              head={[...props.columns.map((c) => t(c.label)), t("admin.actions")]}
            >
              {data.items.map((item) => (
                <tr key={item.id}>
                  {props.columns.map((c) => (
                    <Td key={c.label}>{c.render(item)}</Td>
                  ))}
                  <Td>
                    <div style={{ display: "flex", gap: 8 }}>
                      <SmallButton
                        aria-label={`${t("admin.edit")}: ${props.itemLabel(item)}`}
                        onClick={() => {
                          setEditing(item.id);
                          setValues(props.fromItem(item));
                          setError(null);
                        }}
                      >
                        {t("admin.edit")}
                      </SmallButton>
                      {props.remove && (
                        <SmallButton
                          aria-label={`${t("admin.delete")}: ${props.itemLabel(item)}`}
                          disabled={acting}
                          onClick={() => act(() => remove(item.id))}
                        >
                          {t("admin.delete")}
                        </SmallButton>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
        <h3 style={{ margin: 0 }}>{editing ? t("admin.editing") : t("admin.creating")}</h3>
        <Form
          label={`${t(props.title)}: ${editing ? t("admin.editing") : t("admin.creating")}`}
          onSubmit={submit}
          submitLabel={editing ? t("admin.save") : t("admin.create")}
          error={error}
          busy={busy}
        >
          <FormFields
            fields={typeof props.fields === "function" ? props.fields(editing) : props.fields}
            values={values}
            set={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
          />
          {editing && (
            <div>
              <SmallButton onClick={reset}>{t("admin.cancel")}</SmallButton>
            </div>
          )}
        </Form>
      </Stack>
    </section>
  );
}

/** Строка формы → число или undefined (пусто). */
export function num(v: FormValues[string]): number | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Строка формы → обрезанная строка или null (пусто). */
export function str(v: FormValues[string]): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
