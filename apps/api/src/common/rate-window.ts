/**
 * Counts calls per key in fixed windows (one minute by default) inside this process. Cheap and good enough for the limits that
 * only have to stop runaway clients, not count exactly; with several API instances each keeps its own count (the limit then
 * applies per instance). Old windows are dropped as new ones start, so memory stays bounded.
 */
export class RateWindow {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts one call of `key` at `nowMs`; `ok` is false once the window already holds `limit` calls. */
  hit(key: string, nowMs: number): { ok: boolean; retryAfterSeconds: number } {
    this.sweep(nowMs);
    const start = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const current = this.windows.get(key);
    const window = current && current.start === start ? current : { start, count: 0 };
    this.windows.set(key, window);
    if (window.count >= this.limit) {
      return { ok: false, retryAfterSeconds: Math.ceil((start + this.windowMs - nowMs) / 1000) };
    }
    window.count += 1;
    return { ok: true, retryAfterSeconds: 0 };
  }

  /** Drops the windows that are over (at most once per window length). */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < this.windowMs) return;
    this.lastSweep = nowMs;
    for (const [key, w] of this.windows) {
      if (w.start + this.windowMs <= nowMs) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
