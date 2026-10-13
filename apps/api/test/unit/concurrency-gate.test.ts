import { describe, expect, it } from "vitest";
import { ConcurrencyGate } from "../../src/common/concurrency-gate";

const busy = { code: "BUSY", detail: "busy", retryAfterSeconds: 5 };

describe("ConcurrencyGate", () => {
  it("runs up to max jobs together, refuses the next with 429 and a retry hint, and frees the place afterwards", async () => {
    const gate = new ConcurrencyGate(2, busy);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first = gate.run(() => hold);
    const second = gate.run(() => hold);
    expect(gate.active).toBe(2);
    await expect(gate.run(async () => 1)).rejects.toMatchObject({
      status: 429,
      response: { code: "BUSY", retryAfterSeconds: 5 },
    });
    release();
    await Promise.all([first, second]);
    expect(gate.active).toBe(0);
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("frees the place when a job fails", async () => {
    const gate = new ConcurrencyGate(1, busy);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.active).toBe(0);
  });
});
