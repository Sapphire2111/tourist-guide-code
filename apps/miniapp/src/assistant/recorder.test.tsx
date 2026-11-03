// Unit: запись голоса — микрофон освобождается после записи, по таймауту, при ошибке MediaRecorder и при уходе с
// экрана (в том числе пока ждём разрешения).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { RECORD_MAX_MS, useRecorder } from "./recorder.js";

type Track = { stop: ReturnType<typeof vi.fn> };

let tracks: Track[];
let resolveMedia: ((s: unknown) => void) | null;
let failCtor: boolean;
let recorders: FakeRecorder[];

class FakeRecorder {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: unknown,
    readonly opts: { mimeType: string },
  ) {
    if (failCtor) throw new Error("NotSupportedError");
    recorders.push(this);
  }
  static isTypeSupported(t: string) {
    return t.startsWith("audio/webm");
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["opus"], { type: this.opts.mimeType }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  tracks = [];
  resolveMedia = null;
  failCtor = false;
  recorders = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise((resolve) => {
          resolveMedia = resolve;
        }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Разрешение на микрофон: поток с одной дорожкой. */
async function grant() {
  const track = { stop: vi.fn() };
  tracks.push(track);
  await act(async () => {
    resolveMedia!({ getTracks: () => [track] });
    await Promise.resolve();
  });
  return track;
}

describe("useRecorder", () => {
  it("запись → stop: onDone с Blob, дорожка остановлена", async () => {
    const onDone = vi.fn();
    const { result } = renderHook(() => useRecorder(onDone, vi.fn()));
    expect(result.current.supported).toBe(true);
    act(() => result.current.start());
    expect(result.current.state).toBe("starting");
    const track = await grant();
    expect(result.current.state).toBe("recording");
    act(() => result.current.stop());
    expect(result.current.state).toBe("idle");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect((onDone.mock.calls[0]![0] as Blob).type).toBe("audio/webm;codecs=opus");
    expect(track.stop).toHaveBeenCalled();
  });

  it("таймаут RECORD_MAX_MS — запись завершается сама", async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const { result } = renderHook(() => useRecorder(onDone, vi.fn()));
    act(() => result.current.start());
    const track = await grant();
    act(() => vi.advanceTimersByTime(RECORD_MAX_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it("уход с экрана во время записи — без отправки, микрофон освобождён", async () => {
    const onDone = vi.fn();
    const { result, unmount } = renderHook(() => useRecorder(onDone, vi.fn()));
    act(() => result.current.start());
    const track = await grant();
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("уход с экрана, пока ждём разрешения, — пришедший поток сразу освобождается", async () => {
    const { result, unmount } = renderHook(() => useRecorder(vi.fn(), vi.fn()));
    act(() => result.current.start());
    unmount();
    const track = await grant();
    expect(track.stop).toHaveBeenCalled();
    expect(recorders).toHaveLength(0);
  });

  it("MediaRecorder не создаётся — onError(failed), дорожка остановлена, можно снова", async () => {
    failCtor = true;
    const onError = vi.fn();
    const { result } = renderHook(() => useRecorder(vi.fn(), onError));
    act(() => result.current.start());
    const track = await grant();
    expect(onError).toHaveBeenCalledWith("failed");
    expect(track.stop).toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });
});
