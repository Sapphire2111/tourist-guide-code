// Разовое разбиение packages/i18n/src/messages.ts (полный: `uk` + `en` со всеми ключами) на:
//   messages.ts       — uk без admin.* (+ типы MessageKey/Messages);
//   admin-messages.ts — adminUk / adminEn (admin.*), подключаются через "@tg/i18n/admin";
//   en-messages.ts    — en без admin.*, грузится лениво (loadLocale) или через "@tg/i18n/en".
// Проверяет без потерь (число ключей и равенство значений) и падает при любом расхождении.
// Запуск: node scripts/split-i18n.mjs  (повторно на уже разбитом файле — ошибка).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "..", "packages", "i18n", "src");
const file = (n) => path.join(dir, n);
const fail = (msg) => {
  console.error(`✗ split-i18n: ${msg}`);
  process.exit(1);
};

const src = readFileSync(file("messages.ts"), "utf8").replace(/\r\n/g, "\n");
if (!/^export const en: Messages = \{$/m.test(src)) fail("в messages.ts нет `export const en` — уже разбит?");
if (existsSync(file("admin-messages.ts")) || existsSync(file("en-messages.ts")))
  fail("admin-messages.ts / en-messages.ts уже существуют — удалите их перед повторным разбиением");

/** Тело объектного литерала (строки между `{` и `}`) → объект. Значения — строковые литералы. */
const evalBody = (lines) => new Function(`return {\n${lines.join("\n")}\n};`)();

const lines = src.split("\n");
const keep = []; // остаётся в messages.ts
const ukAdmin = [];
const enCore = [];
const enAdmin = [];
const enLead = []; // комментарии перед `export const en`
const origUk = [];
const origEn = [];
let sect = null;
let cur = null;
for (const line of lines) {
  if (line.startsWith("export const uk = {")) {
    sect = "uk";
    keep.push(line);
    continue;
  }
  if (line.startsWith("export const en: Messages = {")) {
    sect = "en";
    // комментарий непосредственно над en уходит вместе с ним
    while (keep.length && keep.at(-1).startsWith("//")) enLead.unshift(keep.pop());
    continue;
  }
  if (sect && line.startsWith("}")) {
    if (sect === "uk") keep.push(line);
    sect = null;
    continue;
  }
  if (!sect) {
    keep.push(line);
    continue;
  }
  (sect === "uk" ? origUk : origEn).push(line);
  const m = line.match(/^ {2}"([^"]+)":/);
  if (m) {
    const admin = m[1].startsWith("admin.");
    cur = sect === "uk" ? (admin ? ukAdmin : keep) : admin ? enAdmin : enCore;
  } else if (!line.startsWith("    ")) {
    // комментарий / пустая строка в теле — в основной словарь
    cur = sect === "uk" ? keep : enCore;
  }
  cur.push(line);
}
if (sect) fail("незакрытый объект словаря");

let messages = keep.join("\n").replace(/\n+$/, "\n");
const typeLine = "export type MessageKey = keyof typeof uk;";
if (!messages.includes(typeLine)) fail(`в messages.ts не найдено «${typeLine}»`);
messages = messages
  .replace(
    typeLine,
    '/** Ключи: uk (общие) + admin.* (admin-messages.ts, подключаются через "@tg/i18n/admin"). */\n' +
      "export type MessageKey = keyof typeof uk | AdminMessageKey;",
  )
  .replace(
    "export const uk = {",
    'import type { AdminMessageKey } from "./admin-messages.js";\n\nexport const uk = {',
  );

const admin = `// Строки админки (admin.*): отдельно от messages.ts, чтобы не попадать в бандл Mini App.
// Подключаются в словари импортом "@tg/i18n/admin" (побочный эффект) — в точке входа apps/admin.
// Ключи входят в MessageKey; uk — источник истины, как и в messages.ts.
// Сгенерировано scripts/split-i18n.mjs; дальше правится вручную.

export const adminUk = {
${ukAdmin.join("\n")}
} as const;

export type AdminMessageKey = keyof typeof adminUk;

export const adminEn: Partial<Record<AdminMessageKey, string>> = {
${enAdmin.join("\n")}
};
`;

const en = `// en-словарь: отдельный модуль, грузится лениво (loadLocale) или импортом "@tg/i18n/en",
// чтобы не входить в первый экран Mini App (uk по умолчанию).
// Сгенерировано scripts/split-i18n.mjs; дальше правится вручную.
import type { Messages } from "./messages.js";

${enLead.join("\n")}
export const en: Messages = {
${enCore.join("\n")}
};
`;

// --- проверка без потерь ---
const ukBody = (text, name) => {
  const m = text.match(new RegExp(`export const ${name}[^=]*= \\{\\n([\\s\\S]*?)\\n\\}(?: as const)?;`));
  if (!m) fail(`не найден объект ${name}`);
  return evalBody(m[1].split("\n"));
};
const full = { uk: evalBody(origUk), en: evalBody(origEn) };
const out = {
  uk: ukBody(messages, "uk"),
  adminUk: ukBody(admin, "adminUk"),
  adminEn: ukBody(admin, "adminEn"),
  en: ukBody(en, "en"),
};
const check = (name, whole, parts) => {
  const merged = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (Object.hasOwn(merged, k)) fail(`${name}: ключ ${k} попал в две части`);
      merged[k] = v;
    }
  }
  const a = Object.keys(whole);
  const b = Object.keys(merged);
  if (a.length !== b.length) fail(`${name}: было ${a.length} ключей, стало ${b.length}`);
  for (const k of a) if (merged[k] !== whole[k]) fail(`${name}: значение ${k} изменилось`);
};
check("uk", full.uk, [out.uk, out.adminUk]);
check("en", full.en, [out.en, out.adminEn]);
for (const k of Object.keys(out.uk)) if (k.startsWith("admin.")) fail(`uk: ${k} не вынесен`);
for (const k of Object.keys(out.en)) if (k.startsWith("admin.")) fail(`en: ${k} не вынесен`);
for (const k of [...Object.keys(out.adminUk), ...Object.keys(out.adminEn)])
  if (!k.startsWith("admin.")) fail(`admin: лишний ключ ${k}`);
for (const k of Object.keys(out.adminEn))
  if (!Object.hasOwn(out.adminUk, k)) fail(`adminEn: ${k} нет в adminUk`);

writeFileSync(file("messages.ts"), messages);
writeFileSync(file("admin-messages.ts"), admin);
writeFileSync(file("en-messages.ts"), en);
const n = (o) => Object.keys(o).length;
console.log(
  `✓ split-i18n: uk ${n(full.uk)} = ${n(out.uk)} + admin ${n(out.adminUk)}; ` +
    `en ${n(full.en)} = ${n(out.en)} + admin ${n(out.adminEn)}`,
);
