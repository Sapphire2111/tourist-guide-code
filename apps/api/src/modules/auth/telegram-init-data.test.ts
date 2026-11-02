// Unit: проверка initData Telegram (подпись HMAC-SHA256 с ключом из токена бота, срок auth_date, разбор user).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InitDataError,
  initDataSecretKey,
  signInitDataFields,
  validateInitData,
  type InitDataRejection,
} from "./telegram-init-data.js";

// Тестовый токен (не настоящий бот).
const BOT_TOKEN = "123456789:TEST-fake-token-for-unit-tests";
const NOW = new Date("2026-11-02T12:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const MAX_AGE = 24 * 3600;

const USER = {
  id: 279058397,
  first_name: "Олена",
  last_name: "Тест",
  username: "olena_t",
  language_code: "uk",
};

/** initData как у Telegram: поля + hash, подписанные токеном. */
function initData(
  fields: Record<string, string> = {},
  opts: { token?: string; hash?: string | null; extra?: string } = {},
): string {
  const all: Record<string, string> = {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(USER),
    auth_date: String(NOW_SEC - 60),
    ...fields,
  };
  const entries = Object.entries(all);
  const params = new URLSearchParams(entries);
  const hash = opts.hash === undefined ? signInitDataFields(entries, opts.token ?? BOT_TOKEN) : opts.hash;
  if (hash !== null) params.set("hash", hash);
  return params.toString() + (opts.extra ?? "");
}

const validate = (raw: string, maxAgeSec = MAX_AGE) =>
  validateInitData(raw, BOT_TOKEN, { maxAgeSec, now: NOW });

function rejection(fn: () => unknown): InitDataError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InitDataError) return err;
    throw err;
  }
  throw new Error("ожидался InitDataError");
}
const reasonOf = (raw: string, maxAgeSec?: number): InitDataRejection =>
  rejection(() => validate(raw, maxAgeSec)).reason;

describe("validateInitData", () => {
  it("секретный ключ — HMAC_SHA256(key='WebAppData', токен бота), как в документации Telegram", () => {
    expect(initDataSecretKey(BOT_TOKEN)).toEqual(
      createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest(),
    );
    // data-check-string: поля без hash, по алфавиту, через \n.
    const expected = createHmac("sha256", initDataSecretKey(BOT_TOKEN)).update("a=1\nb=2\nc=3").digest("hex");
    expect(
      signInitDataFields(
        [
          ["c", "3"],
          ["a", "1"],
          ["b", "2"],
        ],
        BOT_TOKEN,
      ),
    ).toBe(expected);
  });

  it("правильная подпись: пользователь, auth_date, start_param", () => {
    const result = validate(initData({ start_param: "qr_AbC123", chat_type: "sender" }));
    expect(result.user).toEqual({
      id: USER.id,
      firstName: "Олена",
      lastName: "Тест",
      username: "olena_t",
      languageCode: "uk",
      isPremium: false,
      allowsWriteToPm: false,
      photoUrl: null,
    });
    expect(result.authDate).toEqual(new Date((NOW_SEC - 60) * 1000));
    expect(result.startParam).toBe("qr_AbC123");
    expect(validate(initData()).startParam).toBeNull();
  });

  it("поле signature (Ed25519 для третьих сторон) входит в data-check-string HMAC", () => {
    expect(validate(initData({ signature: "c2lnbmF0dXJl" })).user.id).toBe(USER.id);
  });

  it("подделка: другой токен, изменённое поле, добавленное поле, искажённый hash — bad_signature", () => {
    expect(reasonOf(initData({}, { token: "999:other" }))).toBe("bad_signature");
    const forged = initData().replace(encodeURIComponent('"id":279058397'), encodeURIComponent('"id":1'));
    expect(forged).not.toBe(initData());
    expect(reasonOf(forged)).toBe("bad_signature");
    expect(reasonOf(initData({}, { extra: "&start_param=evil" }))).toBe("bad_signature");
    expect(reasonOf(initData({}, { hash: "0".repeat(64) }))).toBe("bad_signature");
    expect(reasonOf(initData({}, { hash: "XYZ" }))).toBe("bad_signature");
    expect(reasonOf(initData({}, { hash: "A".repeat(64) }))).toBe("bad_signature");
  });

  it("без hash — missing_hash; пустая/слишком длинная строка — malformed", () => {
    expect(reasonOf(initData({}, { hash: null }))).toBe("missing_hash");
    expect(reasonOf("")).toBe("malformed");
    expect(reasonOf("a=" + "x".repeat(9000))).toBe("malformed");
  });

  it("повтор полей (в том числе hash) — duplicate_field, даже если первая копия подписана", () => {
    expect(reasonOf(initData({}, { extra: `&auth_date=${NOW_SEC}` }))).toBe("duplicate_field");
    expect(reasonOf(initData({}, { extra: `&hash=${"0".repeat(64)}` }))).toBe("duplicate_field");
  });

  it("просрочка: auth_date старше срока — expired с id пользователя (подпись верна); граница включительно", () => {
    const old = initData({ auth_date: String(NOW_SEC - MAX_AGE - 1) });
    const err = rejection(() => validate(old));
    expect(err.reason).toBe("expired");
    expect(err.telegramUserId).toBe(USER.id);
    expect(validate(initData({ auth_date: String(NOW_SEC - MAX_AGE) })).user.id).toBe(USER.id);
    // Срок задаётся параметром (env TELEGRAM_INIT_DATA_MAX_AGE_HOURS).
    expect(reasonOf(initData({ auth_date: String(NOW_SEC - 120) }), 60)).toBe("expired");
  });

  it("auth_date из будущего (больше допуска) — from_future; без auth_date или не число — missing_auth_date", () => {
    expect(reasonOf(initData({ auth_date: String(NOW_SEC + 3600) }))).toBe("from_future");
    expect(validate(initData({ auth_date: String(NOW_SEC + 30) })).user.id).toBe(USER.id);
    expect(reasonOf(initData({ auth_date: "вчера" }))).toBe("missing_auth_date");
    const entries: [string, string][] = [["user", JSON.stringify(USER)]];
    const raw = new URLSearchParams([
      ...entries,
      ["hash", signInitDataFields(entries, BOT_TOKEN)],
    ]).toString();
    expect(reasonOf(raw)).toBe("missing_auth_date");
  });

  it("без user — missing_user; битый user (не JSON, без id, бот) — bad_user", () => {
    const entries: [string, string][] = [
      ["auth_date", String(NOW_SEC)],
      ["query_id", "q"],
    ];
    const raw = new URLSearchParams([
      ...entries,
      ["hash", signInitDataFields(entries, BOT_TOKEN)],
    ]).toString();
    expect(reasonOf(raw)).toBe("missing_user");
    expect(reasonOf(initData({ user: "{не json" }))).toBe("bad_user");
    expect(reasonOf(initData({ user: JSON.stringify({ first_name: "x" }) }))).toBe("bad_user");
    expect(reasonOf(initData({ user: JSON.stringify({ id: -5 }) }))).toBe("bad_user");
    expect(reasonOf(initData({ user: JSON.stringify({ id: 1, is_bot: true }) }))).toBe("bad_user");
  });

  it("photo_url — только https; флаги premium и allows_write_to_pm", () => {
    const user = { ...USER, photo_url: "javascript:alert(1)", is_premium: true, allows_write_to_pm: true };
    const parsed = validate(initData({ user: JSON.stringify(user) })).user;
    expect(parsed).toMatchObject({ photoUrl: null, isPremium: true, allowsWriteToPm: true });
    const https = { ...USER, photo_url: "https://t.me/i/userpic/320/x.jpg" };
    expect(validate(initData({ user: JSON.stringify(https) })).user.photoUrl).toBe(https.photo_url);
  });

  it("сообщение ошибки — только код причины, без данных initData", () => {
    const err = rejection(() => validate(initData({}, { token: "999:other" })));
    expect(err.message).toBe("initData отклонён: bad_signature");
    expect(err.message).not.toContain("olena");
  });

  it("пустой токен бота — ошибка программы, не отказ во входе", () => {
    expect(() => validateInitData(initData(), "", { maxAgeSec: MAX_AGE })).toThrow(/токен/);
  });
});
