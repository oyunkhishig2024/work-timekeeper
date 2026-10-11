import { describe, expect, it } from "vitest";
import { DiagLog, MAX_DIAG } from "../src/services/diag";
import { MemoryStore } from "./helpers";

describe("DiagLog", () => {
  it("keeps the newest lines, newest first, and loses none when writers overlap", async () => {
    let t = 1000;
    const log = new DiagLog(new MemoryStore(), () => t++);
    await Promise.all(Array.from({ length: MAX_DIAG + 20 }, (_, i) => log.log(`line ${i}`)));
    const lines = await log.read();
    expect(lines).toHaveLength(MAX_DIAG);
    expect(lines[0]!.m).toBe(`line ${MAX_DIAG + 19}`);
    expect(lines.at(-1)!.m).toBe("line 20");
  });

  it("survives a broken store", async () => {
    const store = new MemoryStore();
    store.data.set("diag.v1", "{not json");
    const log = new DiagLog(store);
    await log.log("still works");
    expect((await log.read()).map((l) => l.m)).toEqual(["still works"]);
  });
});
