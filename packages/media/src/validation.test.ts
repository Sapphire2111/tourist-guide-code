import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "./constants.js";
import { checkUploadedObject, detectMime, validateUploadRequest } from "./validation.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Uint8Array.from([...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBPVP8 ")]);
const PDF = Uint8Array.from(Buffer.from("%PDF-1.7\n"));
const GIF = Uint8Array.from(Buffer.from("GIF89a\x01\x00"));
const HTML = Uint8Array.from(Buffer.from("<html><script>"));

describe("validateUploadRequest: заявленный тип и размер", () => {
  it("фото: jpeg/png/webp принимаются (регистр и пробелы не важны)", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", " IMAGE/JPEG "])
      expect(validateUploadRequest({ kind: "image", mime, size: 1000 }).ok).toBe(true);
  });

  it("фото: gif, svg, pdf, html — mime_not_allowed", () => {
    for (const mime of ["image/gif", "image/svg+xml", "application/pdf", "text/html", ""])
      expect(validateUploadRequest({ kind: "image", mime, size: 1000 })).toEqual({
        ok: false,
        reason: "mime_not_allowed",
      });
  });

  it("приватный документ: ещё и pdf", () => {
    expect(validateUploadRequest({ kind: "private_document", mime: "application/pdf", size: 1 }).ok).toBe(
      true,
    );
    expect(validateUploadRequest({ kind: "private_document", mime: "image/gif", size: 1 }).ok).toBe(false);
  });

  it("размер: 1…10 МиБ; 0, дробный, больше лимита — отказ", () => {
    expect(validateUploadRequest({ kind: "image", mime: "image/png", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
    expect(validateUploadRequest({ kind: "image", mime: "image/png", size: MAX_UPLOAD_BYTES + 1 })).toEqual({
      ok: false,
      reason: "size_too_large",
    });
    for (const size of [0, -1, 1.5, Number.NaN])
      expect(validateUploadRequest({ kind: "image", mime: "image/png", size })).toEqual({
        ok: false,
        reason: "size_invalid",
      });
  });
});

describe("detectMime: сигнатура файла", () => {
  it("jpeg, png, webp, pdf", () => {
    expect(detectMime(JPEG)).toBe("image/jpeg");
    expect(detectMime(PNG)).toBe("image/png");
    expect(detectMime(WEBP)).toBe("image/webp");
    expect(detectMime(PDF)).toBe("application/pdf");
  });

  it("gif, html, пусто, обрезанная сигнатура, RIFF не WEBP — null", () => {
    expect(detectMime(GIF)).toBeNull();
    expect(detectMime(HTML)).toBeNull();
    expect(detectMime(new Uint8Array())).toBeNull();
    expect(detectMime(PNG.subarray(0, 4))).toBeNull();
    expect(
      detectMime(Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])),
    ).toBeNull();
  });
});

describe("checkUploadedObject: подтверждение загрузки", () => {
  it("совпали размер и тип — ok", () => {
    expect(checkUploadedObject({ mime: "image/png", size: 100 }, { size: 100, head: PNG })).toEqual({
      ok: true,
    });
  });

  it("файл недопустимого типа под видом jpeg — type_mismatch", () => {
    expect(checkUploadedObject({ mime: "image/jpeg", size: 100 }, { size: 100, head: HTML })).toEqual({
      ok: false,
      reason: "type_mismatch",
    });
    expect(checkUploadedObject({ mime: "image/jpeg", size: 100 }, { size: 100, head: PNG })).toEqual({
      ok: false,
      reason: "type_mismatch",
    });
  });

  it("нет объекта — not_uploaded; другой размер — size_mismatch", () => {
    expect(checkUploadedObject({ mime: "image/png", size: 100 }, null)).toEqual({
      ok: false,
      reason: "not_uploaded",
    });
    expect(checkUploadedObject({ mime: "image/png", size: 100 }, { size: 101, head: PNG })).toEqual({
      ok: false,
      reason: "size_mismatch",
    });
  });
});
