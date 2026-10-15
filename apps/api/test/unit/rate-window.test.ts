import { describe, expect, it } from "vitest";
import { RateWindow } from "../../src/common/rate-window";

describe("RateWindow", () => {
  it("allows `limit` calls per window, then says when to come back", () => {
    const w = new RateWindow(3);
    const t = Date.UTC(2026, 9, 6, 8, 0, 20); // 20 s into a minute
    expect([1, 2, 3].map(() => w.hit("a", t).ok)).toEqual([true, true, true]);
    const refused = w.hit("a", t + 1000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSeconds).toBe(39); // until the next minute starts
    expect(w.hit("b", t).ok).toBe(true); // another key is not affected
  });

  it("starts counting again in the next window and drops old windows", () => {
    const w = new RateWindow(1);
    const t = Date.UTC(2026, 9, 6, 8, 0, 0);
    expect(w.hit("a", t).ok).toBe(true);
    expect(w.hit("a", t + 1).ok).toBe(false);
    expect(w.hit("a", t + 60_000).ok).toBe(true);
    for (let i = 0; i < 50; i += 1) w.hit(`k${i}`, t + 60_000);
    w.hit("x", t + 180_000); // sweeps what is over
    expect(w.size).toBe(1);
  });
});
