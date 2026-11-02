// Общие элементы экранов админки: контекст (клиент API, сессия), поля форм, ошибки, таблицы.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { MessageKey } from "@tg/i18n";
import { pickLocalized, type LocalizedText } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import type { ApiClient, ApiError, Result, Session } from "./api.js";

export type AdminContextValue = {
  api: ApiClient;
  session: Session;
  setSession: (s: Session) => void;
};

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin вне AdminContext");
  return ctx;
}

/** Текст мультиязычного поля на языке интерфейса. */
export function useLocalized(): (text: LocalizedText | null | undefined) => string {
  const { locale } = useT();
  return (text) => (text ? pickLocalized(text, locale) : "");
}

/** Загрузка данных экрана: [результат, перезагрузка]. */
export function useLoad<T>(
  load: () => Promise<Result<T>>,
  deps: unknown[],
): [Result<T> | undefined, () => void] {
  const [result, setResult] = useState<Result<T>>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void load().then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [result, useCallback(() => setTick((n) => n + 1), [])];
}

export const inputStyle: CSSProperties = {
  font: "inherit",
  padding: "6px 8px",
  border: "1px solid #6b6f75",
  borderRadius: 6,
  background: "var(--color-bg)",
  color: "var(--color-text)",
  minWidth: 0,
};

/** Второстепенная кнопка (обычный размер, рамка). */
export function SmallButton(props: React.ComponentProps<"button">) {
  return (
    <Button
      {...props}
      style={{
        fontSize: "1rem",
        fontWeight: 600,
        padding: "6px 12px",
        background: "var(--color-bg)",
        color: "var(--color-link)",
        border: "1px solid var(--color-link)",
        ...props.style,
      }}
    />
  );
}

/** Ошибка из конверта API: сообщение, ошибки полей, причины. */
export function ErrorBox({ error }: { error?: ApiError | null }) {
  const { tDynamic } = useT();
  if (!error) return null;
  // Причины и проблемы — ключи admin.problem.<код>; без перевода (служебная причина) не показываются.
  const problems = (error.problems ?? [])
    .map((p) => tDynamic(`admin.problem.${p}`))
    .filter((text) => !text.startsWith("admin.problem."));
  return (
    <div role="alert" style={{ color: "#b3261e", border: "1px solid #b3261e", borderRadius: 6, padding: 8 }}>
      <p style={{ margin: 0 }}>{tDynamic(error.messageKey)}</p>
      {(problems.length > 0 || !!error.fields?.length) && (
        <ul style={{ margin: "4px 0 0" }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
          {/* Подпись поля: admin.fieldName.<путь>, откат к родителю (name.uk → name), иначе общее «Поле». */}
          {error.fields?.map((f) => (
            <li key={f.field + f.messageKey}>
              {tDynamic(`admin.fieldName.${f.field}`)}: {tDynamic(f.messageKey)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Сообщение об успехе (озвучивается). */
export function Notice({ text }: { text?: string | null }) {
  return (
    <p role="status" style={{ margin: 0, minHeight: "1.45em", color: "#1e6b34" }}>
      {text ?? ""}
    </p>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  step?: string;
  maxLength?: number;
};

/** Поле ввода с подписью. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  multiline,
  placeholder,
  step,
  maxLength,
}: FieldProps) {
  const id = useId();
  const common = {
    id,
    maxLength,
    value,
    required,
    placeholder,
    style: { ...inputStyle, width: "100%" },
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={type} step={step} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

/** Выпадающий список с подписью; `empty` — пункт «не выбрано». */
export function SelectField({
  label,
  value,
  onChange,
  options,
  empty,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  empty?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      <select
        id={id}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Значение мультиязычного поля в форме: uk обязателен (если поле обязательно), en — по желанию. */
export type LocalizedValue = { uk: string; en: string };
export const emptyLocalized = (): LocalizedValue => ({ uk: "", en: "" });
export function fromLocalized(text: { uk: string; en?: string } | null | undefined): LocalizedValue {
  return { uk: text?.uk ?? "", en: text?.en ?? "" };
}
/** В тело запроса: пустой uk — null (поле не заполнено); пустой en не передаётся. */
export function toLocalized(v: LocalizedValue): { uk: string; en?: string } | null {
  const uk = v.uk.trim();
  const en = v.en.trim();
  if (!uk) return null;
  return en ? { uk, en } : { uk };
}

export function LocalizedField({
  label,
  value,
  onChange,
  required,
  multiline,
  maxLength,
}: {
  label: string;
  value: LocalizedValue;
  onChange: (v: LocalizedValue) => void;
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
}) {
  const { t } = useT();
  return (
    <fieldset style={{ border: "1px solid #c4c7cc", borderRadius: 6, margin: 0 }}>
      <legend>{label}</legend>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field
          label={t("admin.lang.uk")}
          value={value.uk}
          required={required}
          multiline={multiline}
          maxLength={maxLength}
          onChange={(uk) => onChange({ ...value, uk })}
        />
        <Field
          label={t("admin.lang.en")}
          value={value.en}
          multiline={multiline}
          maxLength={maxLength}
          onChange={(en) => onChange({ ...value, en })}
        />
      </div>
    </fieldset>
  );
}

export const tableStyle: CSSProperties = { borderCollapse: "collapse", width: "100%" };
export const cellStyle: CSSProperties = {
  borderBottom: "1px solid #c4c7cc",
  padding: "6px 8px",
  textAlign: "left",
  verticalAlign: "top",
};

/** Таблица: заголовки + строки. */
export function Table({ head, children, caption }: { head: string[]; children: ReactNode; caption: string }) {
  return (
    <table style={tableStyle}>
      <caption style={{ textAlign: "left", fontWeight: 600, padding: "4px 0" }}>{caption}</caption>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i} scope="col" style={cellStyle}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Td({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return <td style={{ ...cellStyle, ...style }}>{children}</td>;
}

/** Загрузка / ошибка / содержимое результата. */
export function Loaded<T>({
  result,
  children,
}: {
  result: Result<T> | undefined;
  children: (data: T) => ReactNode;
}) {
  const { t } = useT();
  if (!result) return <p>{t("admin.loading")}</p>;
  if (!result.ok) return <ErrorBox error={result.error} />;
  return <>{children(result.data)}</>;
}

/**
 * Мутация «одна за раз»: повторный запуск, пока идёт предыдущий, игнорируется (двойной клик, Enter).
 * Флаг в ref — два клика в одном такте оба видят занятость.
 */
export function useBusy(): [boolean, (fn: () => Promise<unknown> | unknown) => void] {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback((fn: () => Promise<unknown> | unknown) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    void Promise.resolve()
      .then(fn)
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  }, []);
  return [busy, run];
}

/** Форма с кнопкой отправки и ошибкой; отправка — одна за раз (useBusy). */
export function Form({
  onSubmit,
  submitLabel,
  error,
  busy,
  children,
  label,
}: {
  onSubmit: () => Promise<unknown> | unknown;
  submitLabel: string;
  error?: ApiError | null;
  busy?: boolean;
  children: ReactNode;
  label: string;
}) {
  const [pending, run] = useBusy();
  return (
    <form
      aria-label={label}
      aria-busy={pending || busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        run(onSubmit);
      }}
    >
      <Stack gap={2}>
        {children}
        <ErrorBox error={error} />
        <div>
          <Button type="submit" disabled={pending || busy}>
            {submitLabel}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

export const row: CSSProperties = { display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" };
export const grid2: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };

export type { MessageKey };
