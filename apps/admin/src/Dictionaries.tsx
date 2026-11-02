// Справочники региона (AD07/AD08): населённые пункты, категории и теги; экстренные контакты.
import { useT } from "@tg/ui";
import { call, type ApiSchemas } from "./api.js";
import { CrudSection, num, str, type FieldDef, type FormValues } from "./Crud.js";
import { fromLocalized, toLocalized, useAdmin, useLoad, useLocalized, type LocalizedValue } from "./ui.js";

type Locality = ApiSchemas["LocalityDto"];
type Category = ApiSchemas["CategoryDto"];
type Tag = ApiSchemas["TagDto"];
type Contact = ApiSchemas["AdminEmergencyContactDto"];

const LOCALITY_KINDS = ["settlement", "zone", "landmark"] as const;
const TAG_GROUPS = ["cuisine", "audience", "amenity", "season", "weather", "other"] as const;
const HOME_SECTIONS = ["about", "stay", "eat", "shop", "relax", "fun", "nearby", "transfer", "help"] as const;
export const CONTACT_KINDS = [
  "general",
  "police",
  "ambulance",
  "rescue",
  "mountain_rescue",
  "other",
] as const;

const loc = (v: FormValues[string]) => toLocalized(v as LocalizedValue);
/** Обязательное мультиязычное поле: пустое — { uk: "" } (сервер вернёт ошибку поля). */
const required = (v: FormValues[string]) => loc(v) ?? { uk: "" };
const text = (v: FormValues[string]) => (typeof v === "string" ? v.trim() : "");
const yesNo = (t: (k: "admin.yes" | "admin.no") => string, v: boolean) =>
  v ? t("admin.yes") : t("admin.no");

export function LocalitiesScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const fields: FieldDef[] = [
    { key: "code", label: "admin.field.code", kind: "text", required: true },
    {
      key: "kind",
      label: "admin.field.kind",
      kind: "select",
      options: LOCALITY_KINDS.map((k) => ({ value: k, label: tDynamic(`admin.localityKind.${k}`) })),
    },
    { key: "name", label: "admin.field.name", kind: "localized", required: true },
    { key: "lat", label: "admin.field.lat", kind: "number", step: "any" },
    { key: "lon", label: "admin.field.lon", kind: "number", step: "any" },
    { key: "sortOrder", label: "admin.field.sortOrder", kind: "number" },
    { key: "active", label: "admin.field.active", kind: "checkbox" },
  ];
  return (
    <CrudSection<Locality, ApiSchemas["CreateLocalityDto"]>
      title="admin.localities"
      load={() => call(api.GET("/admin/localities"))}
      create={(body) => call(api.POST("/admin/localities", { body }))}
      update={(id, body) => call(api.PATCH("/admin/localities/{id}", { params: { path: { id } }, body }))}
      remove={(id) => call(api.DELETE("/admin/localities/{id}", { params: { path: { id } } }))}
      fields={fields}
      empty={() => ({
        code: "",
        kind: "settlement",
        name: { uk: "", en: "" },
        lat: "",
        lon: "",
        sortOrder: "0",
        active: true,
      })}
      fromItem={(i) => ({
        code: i.code,
        kind: i.kind,
        name: fromLocalized(i.name),
        lat: i.location ? String(i.location.lat) : "",
        lon: i.location ? String(i.location.lon) : "",
        sortOrder: String(i.sortOrder),
        active: i.active,
      })}
      toBody={(v) => {
        const lat = num(v.lat);
        const lon = num(v.lon);
        return {
          code: text(v.code),
          kind: v.kind as Locality["kind"],
          name: required(v.name),
          location: lat !== undefined && lon !== undefined ? { lat, lon } : null,
          sortOrder: num(v.sortOrder) ?? 0,
          active: v.active === true,
        };
      }}
      columns={[
        { label: "admin.field.code", render: (i) => i.code },
        { label: "admin.field.name", render: (i) => l(i.name) },
        { label: "admin.field.kind", render: (i) => tDynamic(`admin.localityKind.${i.kind}`) },
        { label: "admin.field.active", render: (i) => yesNo(t, i.active) },
      ]}
      itemLabel={(i) => l(i.name)}
    />
  );
}

export function TaxonomyScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  // Корневые категории — для выбора родителя (один уровень вложенности).
  const [cats, reloadCats] = useLoad(() => call(api.GET("/admin/categories")), []);
  const roots = cats?.ok ? cats.data.items.filter((c) => c.parentId === null) : [];
  // Родитель — корневая категория, кроме самой редактируемой.
  const categoryFields = (editing: string | null): FieldDef[] => [
    { key: "code", label: "admin.field.code", kind: "text", required: true },
    { key: "name", label: "admin.field.name", kind: "localized", required: true },
    {
      key: "parentId",
      label: "admin.field.parent",
      kind: "select",
      empty: t("admin.none"),
      options: roots.filter((c) => c.id !== editing).map((c) => ({ value: c.id, label: l(c.name) })),
    },
    {
      key: "homeSection",
      label: "admin.field.homeSection",
      kind: "select",
      empty: t("admin.none"),
      options: HOME_SECTIONS.map((s) => ({ value: s, label: tDynamic(`admin.homeSection.${s}`) })),
    },
    { key: "icon", label: "admin.field.icon", kind: "text" },
    { key: "sortOrder", label: "admin.field.sortOrder", kind: "number" },
    { key: "active", label: "admin.field.active", kind: "checkbox" },
  ];
  const tagFields: FieldDef[] = [
    { key: "code", label: "admin.field.code", kind: "text", required: true },
    { key: "name", label: "admin.field.name", kind: "localized", required: true },
    {
      key: "group",
      label: "admin.field.group",
      kind: "select",
      options: TAG_GROUPS.map((g) => ({ value: g, label: tDynamic(`admin.tagGroup.${g}`) })),
    },
    { key: "sortOrder", label: "admin.field.sortOrder", kind: "number" },
    { key: "active", label: "admin.field.active", kind: "checkbox" },
  ];
  return (
    <>
      <CrudSection<Category, ApiSchemas["CreateCategoryDto"]>
        title="admin.categories"
        load={() => call(api.GET("/admin/categories"))}
        create={(body) => call(api.POST("/admin/categories", { body }))}
        update={(id, body) => call(api.PATCH("/admin/categories/{id}", { params: { path: { id } }, body }))}
        remove={(id) => call(api.DELETE("/admin/categories/{id}", { params: { path: { id } } }))}
        fields={categoryFields}
        onChanged={reloadCats}
        empty={() => ({
          code: "",
          name: { uk: "", en: "" },
          parentId: "",
          homeSection: "",
          icon: "",
          sortOrder: "0",
          active: true,
        })}
        fromItem={(i) => ({
          code: i.code,
          name: fromLocalized(i.name),
          parentId: i.parentId ?? "",
          homeSection: i.homeSection ?? "",
          icon: i.icon ?? "",
          sortOrder: String(i.sortOrder),
          active: i.active,
        })}
        toBody={(v) => ({
          code: text(v.code),
          name: required(v.name),
          parentId: str(v.parentId),
          homeSection: str(v.homeSection) as Category["homeSection"],
          icon: str(v.icon),
          sortOrder: num(v.sortOrder) ?? 0,
          active: v.active === true,
        })}
        columns={[
          { label: "admin.field.code", render: (i) => i.code },
          { label: "admin.field.name", render: (i) => l(i.name) },
          {
            label: "admin.field.parent",
            render: (i) => (i.parentId ? l(roots.find((r) => r.id === i.parentId)?.name) : "—"),
          },
          { label: "admin.field.active", render: (i) => yesNo(t, i.active) },
        ]}
        itemLabel={(i) => l(i.name)}
      />
      <CrudSection<Tag, ApiSchemas["CreateTagDto"]>
        title="admin.tags"
        load={() => call(api.GET("/admin/tags"))}
        create={(body) => call(api.POST("/admin/tags", { body }))}
        update={(id, body) => call(api.PATCH("/admin/tags/{id}", { params: { path: { id } }, body }))}
        remove={(id) => call(api.DELETE("/admin/tags/{id}", { params: { path: { id } } }))}
        fields={tagFields}
        empty={() => ({ code: "", name: { uk: "", en: "" }, group: "other", sortOrder: "0", active: true })}
        fromItem={(i) => ({
          code: i.code,
          name: fromLocalized(i.name),
          group: i.group,
          sortOrder: String(i.sortOrder),
          active: i.active,
        })}
        toBody={(v) => ({
          code: text(v.code),
          name: required(v.name),
          group: v.group as Tag["group"],
          sortOrder: num(v.sortOrder) ?? 0,
          active: v.active === true,
        })}
        columns={[
          { label: "admin.field.code", render: (i) => i.code },
          { label: "admin.field.name", render: (i) => l(i.name) },
          { label: "admin.field.group", render: (i) => tDynamic(`admin.tagGroup.${i.group}`) },
          { label: "admin.field.active", render: (i) => yesNo(t, i.active) },
        ]}
        itemLabel={(i) => l(i.name)}
      />
    </>
  );
}

export function EmergencyScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const fields: FieldDef[] = [
    {
      key: "kind",
      label: "admin.field.kind",
      kind: "select",
      options: CONTACT_KINDS.map((k) => ({ value: k, label: tDynamic(`admin.contactKind.${k}`) })),
    },
    { key: "phone", label: "admin.field.phone", kind: "text", required: true },
    { key: "name", label: "admin.field.name", kind: "localized", required: true },
    { key: "description", label: "admin.field.description", kind: "localized", multiline: true },
    { key: "sortOrder", label: "admin.field.sortOrder", kind: "number" },
    { key: "active", label: "admin.field.active", kind: "checkbox" },
  ];
  return (
    <CrudSection<Contact, ApiSchemas["CreateEmergencyContactDto"]>
      title="admin.emergency"
      load={() => call(api.GET("/admin/emergency-contacts"))}
      create={(body) => call(api.POST("/admin/emergency-contacts", { body }))}
      update={(id, body) =>
        call(api.PATCH("/admin/emergency-contacts/{id}", { params: { path: { id } }, body }))
      }
      remove={(id) => call(api.DELETE("/admin/emergency-contacts/{id}", { params: { path: { id } } }))}
      fields={fields}
      empty={() => ({
        kind: "general",
        phone: "",
        name: { uk: "", en: "" },
        description: { uk: "", en: "" },
        sortOrder: "0",
        active: true,
      })}
      fromItem={(i) => ({
        kind: i.kind,
        phone: i.phone,
        name: fromLocalized(i.name),
        description: fromLocalized(i.description),
        sortOrder: String(i.sortOrder),
        active: i.active,
      })}
      toBody={(v) => ({
        kind: v.kind as Contact["kind"],
        phone: text(v.phone),
        name: required(v.name),
        description: loc(v.description),
        sortOrder: num(v.sortOrder) ?? 0,
        active: v.active === true,
      })}
      columns={[
        { label: "admin.field.kind", render: (i) => tDynamic(`admin.contactKind.${i.kind}`) },
        { label: "admin.field.name", render: (i) => l(i.name) },
        { label: "admin.field.phone", render: (i) => i.phone },
        { label: "admin.field.active", render: (i) => yesNo(t, i.active) },
      ]}
      itemLabel={(i) => l(i.name)}
    />
  );
}
