import { describe, expect, it } from "vitest";
import type { ApiEvent, EventResult } from "../src/lib/api";
import { ApiError, NetworkError, SessionEndedError } from "../src/lib/errors";
import { Outbox, type OutboxEvent } from "../src/services/outbox";
import { flushOutbox, toApiEvent } from "../src/services/sync";
import { MemoryStore } from "./helpers";

const ev = (id: string, over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  clientEventId: id,
  type: "ENTER",
  locationId: "loc",
  capturedAt: 1_000,
  ...over,
});
const accepted = (id: string): EventResult => ({
  clientEventId: id,
  outcome: "ACCEPTED",
  occurredAt: "t",
  counted: true,
  flags: [],
});

async function filled(n: number) {
  const box = new Outbox(new MemoryStore());
  for (let i = 0; i < n; i++) await box.enqueue(ev(`e${i}`));
  return box;
}

describe("toApiEvent", () => {
  it("works the age out at upload time and carries the evidence", () => {
    const e = ev("a", {
      capturedAt: 10_000,
      accuracyM: 12,
      mockLocation: true,
      lat: 47.9,
      lng: 106.9,
    });
    expect(toApiEvent(e, 70_000)).toEqual({
      clientEventId: "a",
      type: "ENTER",
      locationId: "loc",
      ageMs: 60_000,
      deviceTime: new Date(10_000).toISOString(),
      accuracyM: 12,
      mockLocation: true,
      lat: 47.9,
      lng: 106.9,
    });
  });
  it("never sends a negative age (a clock set back), and omits what it does not have", () => {
    const out = toApiEvent(ev("a", { capturedAt: 90_000 }), 10_000);
    expect(out.ageMs).toBe(0);
    expect(out).not.toHaveProperty("lat");
    expect(out).not.toHaveProperty("mockLocation");
  });
});

describe("flushOutbox", () => {
  it("uploads in batches of 50 and empties the queue", async () => {
    const box = await filled(120);
    const sizes: number[] = [];
    const out = await flushOutbox(box, {
      postEvents: async (events: ApiEvent[]) => {
        sizes.push(events.length);
        return { received: events.length, results: events.map((e) => accepted(e.clientEventId)) };
      },
    });
    expect(sizes).toEqual([50, 50, 20]);
    expect(out).toEqual({ state: "DONE", sent: 120 });
    expect(await box.size()).toBe(0);
  });

  it("nothing to send is EMPTY", async () => {
    const out = await flushOutbox(await filled(0), {
      postEvents: async () => ({ received: 0, results: [] }),
    });
    expect(out).toEqual({ state: "EMPTY", sent: 0 });
  });

  it("an event leaves the queue whatever the server says about it: accepted, duplicate or rejected", async () => {
    const box = await filled(3);
    await flushOutbox(box, {
      postEvents: async (events) => ({
        received: 3,
        results: [
          accepted(events[0]!.clientEventId),
          { clientEventId: events[1]!.clientEventId, outcome: "DUPLICATE" },
          {
            clientEventId: events[2]!.clientEventId,
            outcome: "REJECTED",
            code: "UNKNOWN_LOCATION",
          },
        ],
      }),
    });
    expect(await box.size()).toBe(0);
  });

  it("no network keeps everything for the next try", async () => {
    const box = await filled(3);
    const out = await flushOutbox(box, {
      postEvents: async () => Promise.reject(new NetworkError()),
    });
    expect(out).toEqual({ state: "OFFLINE", sent: 0 });
    expect(await box.size()).toBe(3);
  });

  it("a server error or throttling is a later try, not a loss", async () => {
    for (const status of [429, 500, 503]) {
      const box = await filled(2);
      const out = await flushOutbox(box, {
        postEvents: async () => Promise.reject(new ApiError(status, "X", "x")),
      });
      expect(out.state).toBe("OFFLINE");
      expect(await box.size()).toBe(2);
    }
  });

  it("a disabled phone or withdrawn consent (403) stops the upload and keeps the events", async () => {
    const box = await filled(2);
    const out = await flushOutbox(box, {
      postEvents: async () => Promise.reject(new ApiError(403, "DEVICE_REQUIRED", "x")),
    });
    expect(out).toEqual({ state: "BLOCKED", sent: 0, code: "DEVICE_REQUIRED" });
    expect(await box.size()).toBe(2);
  });

  it("an ended session stops the upload and keeps the events", async () => {
    const box = await filled(2);
    const out = await flushOutbox(box, {
      postEvents: async () => Promise.reject(new SessionEndedError()),
    });
    expect(out.state).toBe("SIGNED_OUT");
    expect(await box.size()).toBe(2);
  });

  it("one invalid event cannot hold the others back: a refused batch is sent one by one", async () => {
    const box = await filled(3);
    const out = await flushOutbox(box, {
      postEvents: async (events) => {
        if (events.length > 1 || events[0]!.clientEventId === "e1")
          throw new ApiError(400, "VALIDATION", "bad");
        return { received: 1, results: [accepted(events[0]!.clientEventId)] };
      },
    });
    expect(out.state).toBe("DONE");
    expect(await box.size()).toBe(0); // e0 and e2 accepted, e1 dropped
  });

  it("a server that answers nothing does not loop forever", async () => {
    const box = await filled(2);
    const out = await flushOutbox(box, { postEvents: async () => ({ received: 0, results: [] }) });
    expect(out.state).toBe("BLOCKED");
    expect(await box.size()).toBe(2);
  });
});
