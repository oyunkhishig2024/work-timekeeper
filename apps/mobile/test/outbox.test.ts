import { describe, expect, it } from "vitest";
import { MAX_OUTBOX, Outbox, type OutboxEvent } from "../src/services/outbox";
import { MemoryStore } from "./helpers";

const ev = (id: string, over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  clientEventId: id,
  type: "ENTER",
  locationId: "loc",
  capturedAt: 1,
  ...over,
});

describe("Outbox", () => {
  it("keeps events in order and removes only what was acknowledged", async () => {
    const box = new Outbox(new MemoryStore());
    await box.enqueue(ev("a"));
    await box.enqueue(ev("b"));
    await box.enqueue(ev("c"));
    expect((await box.peek(2)).map((e) => e.clientEventId)).toEqual(["a", "b"]);
    expect(await box.size()).toBe(3); // peek does not remove
    await box.acknowledge(["a", "c"]);
    expect((await box.peek(10)).map((e) => e.clientEventId)).toEqual(["b"]);
  });

  it("the same event twice is queued once", async () => {
    const box = new Outbox(new MemoryStore());
    await box.enqueue(ev("a"));
    await box.enqueue(ev("a"));
    expect(await box.size()).toBe(1);
  });

  it("two events arriving together are both kept", async () => {
    const box = new Outbox(new MemoryStore());
    await Promise.all(Array.from({ length: 20 }, (_, i) => box.enqueue(ev(`e${i}`))));
    expect(await box.size()).toBe(20);
  });

  it("survives a new instance over the same storage (the app was restarted)", async () => {
    const store = new MemoryStore();
    await new Outbox(store).enqueue(ev("a"));
    expect((await new Outbox(store).peek(5)).map((e) => e.clientEventId)).toEqual(["a"]);
  });

  it("a damaged queue does not block new events", async () => {
    const store = new MemoryStore();
    await store.setItem("outbox.v1", "{not json");
    const box = new Outbox(store);
    await box.enqueue(ev("a"));
    expect(await box.size()).toBe(1);
  });

  it("drops the oldest events beyond the limit", async () => {
    const box = new Outbox(new MemoryStore());
    for (let i = 0; i < MAX_OUTBOX + 3; i++) await box.enqueue(ev(`e${i}`));
    const all = await box.peek(MAX_OUTBOX + 10);
    expect(all).toHaveLength(MAX_OUTBOX);
    expect(all[0]!.clientEventId).toBe("e3");
  });
});
