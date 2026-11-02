import { systemContext } from "@tg/queue-contract";
import { describe, expect, it } from "vitest";
import { currentJobContext, runInJobContext } from "./context.js";

describe("JobContext в рантайме", () => {
  it("контекст доступен внутри runInJobContext, включая async-продолжения", async () => {
    expect(currentJobContext()).toBeUndefined();
    const seen = await runInJobContext(systemContext("r-2"), async () => {
      await Promise.resolve();
      return currentJobContext();
    });
    expect(seen).toEqual({ actor: "SYSTEM", regionId: "r-2" });
    expect(currentJobContext()).toBeUndefined();
  });
});
