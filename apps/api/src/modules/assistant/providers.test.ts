// Unit (сеть подменена): запрос к Google Speech-to-Text v1 — язык uk-UA, Opus, ключ в заголовке (не в адресе),
// ошибки без текста и аудио туриста в логах.
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantUpstreamError, createAnthropicLlm, createGoogleSpeech } from "./providers.js";

afterEach(() => vi.restoreAllMocks());

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createGoogleSpeech", () => {
  it("speech:recognize: uk-UA, WEBM_OPUS/OGG_OPUS, base64, ключ — в X-Goog-Api-Key", async () => {
    const fetchImpl = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        jsonResponse({
          results: [
            { alternatives: [{ transcript: " кав'ярня " }] },
            { alternatives: [{ transcript: "поруч" }] },
          ],
        }),
      ),
    );
    const speech = createGoogleSpeech("KEY", fetchImpl as unknown as typeof fetch);
    expect(speech.enabled).toBe(true);
    expect(await speech.recognize(Buffer.from("abc"), "audio/webm")).toBe("кав'ярня поруч");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://speech.googleapis.com/v1/speech:recognize");
    expect(url).not.toContain("KEY");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("KEY");
    const body = JSON.parse(init.body as string) as {
      config: Record<string, unknown>;
      audio: { content: string };
    };
    expect(body.config).toMatchObject({
      encoding: "WEBM_OPUS",
      languageCode: "uk-UA",
      sampleRateHertz: 48000,
    });
    expect(body.audio.content).toBe(Buffer.from("abc").toString("base64"));

    await speech.recognize(Buffer.from("abc"), "audio/ogg");
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body as string).config.encoding).toBe("OGG_OPUS");
  });

  it("нет результатов — пустая строка", async () => {
    const speech = createGoogleSpeech("KEY", (() =>
      Promise.resolve(jsonResponse({}))) as unknown as typeof fetch);
    expect(await speech.recognize(Buffer.from("abc"), "audio/webm")).toBe("");
  });

  it("ошибки: плохое аудио — rejected, ключ/выключенный API — config, 5xx — upstream; в лог — только коды", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const err = (status: number, error: Record<string, unknown>) =>
      createGoogleSpeech("KEY", (() =>
        Promise.resolve(
          jsonResponse({ error: { message: "секрет туриста", ...error } }, status),
        )) as unknown as typeof fetch)
        .recognize(Buffer.from("секрет"), "audio/webm")
        .then(
          () => undefined,
          (e: unknown) => e as AssistantUpstreamError,
        );
    expect((await err(400, { status: "INVALID_ARGUMENT" }))?.reason).toBe("rejected");
    expect(
      (await err(400, { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] }))?.reason,
    ).toBe("config");
    expect(
      (await err(403, { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] }))?.reason,
    ).toBe("config");
    expect((await err(503, { status: "UNAVAILABLE" }))?.reason).toBe("upstream");
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged).toEqual([
      "Speech-to-Text: 400 INVALID_ARGUMENT",
      "Speech-to-Text: 400 INVALID_ARGUMENT/API_KEY_INVALID",
      "Speech-to-Text: 403 PERMISSION_DENIED/SERVICE_DISABLED",
      "Speech-to-Text: 503 UNAVAILABLE",
    ]);
    expect(logged.join(" ")).not.toContain("секрет");
  });

  it("без ключа — выключен", () => {
    expect(createGoogleSpeech(undefined).enabled).toBe(false);
  });
});

describe("createAnthropicLlm", () => {
  it("без ключа — выключен и не обращается к API", async () => {
    const llm = createAnthropicLlm(undefined);
    expect(llm.enabled).toBe(false);
    await expect(llm.create({} as never)).rejects.toBeInstanceOf(AssistantUpstreamError);
  });
});
