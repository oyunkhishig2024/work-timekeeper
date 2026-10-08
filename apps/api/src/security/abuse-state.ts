/**
 * What the detector remembers about one client address, and where it is kept.
 *
 * The detector's rules are a function `(state, event, now) -> new state` (abuse-detector.ts). A state store applies such
 * a function ATOMICALLY to the state of one key: `MemoryStateStore` (one process, the default) or the Redis store in
 * abuse-redis.ts (several API instances share the judgement). The rules exist once; stores only move state around.
 */

export interface IpState {
  score: number;
  scoreAt: number;
  lastSeen: number;
  blockedUntil: number;
  /** End times of recent bans: a strike is remembered for `strikeMemoryMinutes` after its ban ended. */
  bans: number[];
  /** Per-signal counts since the state was created (shown in the audit trail of a ban). */
  counts: Record<string, number>;
  usernames: Map<string, number>;
  paths: Map<string, number>;
  /** Timestamps of anonymous requests in the last minute (only kept while needed). */
  anonRecent: number[];
  anonBucket: number;
  anonBucketCount: number;
  anonBucketFlagged: boolean;
  anonBurstStreak: number;
  authBucket: number;
  authBucketCount: number;
  stuffingAt: number;
  enumerationAt: number;
  scannerAt: number;
  wasThrottled: boolean;
}

export function newIpState(now: number): IpState {
  return {
    score: 0,
    scoreAt: now,
    lastSeen: now,
    blockedUntil: 0,
    bans: [],
    counts: {},
    usernames: new Map(),
    paths: new Map(),
    anonRecent: [],
    anonBucket: 0,
    anonBucketCount: 0,
    anonBucketFlagged: false,
    anonBurstStreak: 0,
    authBucket: 0,
    authBucketCount: 0,
    stuffingAt: 0,
    enumerationAt: 0,
    scannerAt: 0,
    wasThrottled: false,
  };
}

export function encodeState(state: IpState): string {
  return JSON.stringify({
    ...state,
    usernames: [...state.usernames],
    paths: [...state.paths],
  });
}

/** Returns null for anything that is not a state this code wrote (the caller then starts clean). */
export function decodeState(raw: string | null | undefined): IpState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.score !== "number" || !Array.isArray(data.bans)) return null;
    return {
      ...(data as unknown as IpState),
      usernames: new Map(data.usernames as Array<[string, number]>),
      paths: new Map(data.paths as Array<[string, number]>),
    };
  } catch {
    return null;
  }
}

/**
 * One atomic step on the state of a key. `fn` receives the current state (null if there is none) and returns the
 * result for the caller plus, when something must be kept, the state to store (`state`) or `remove`.
 * `fn` must be free of side effects: a store may run it more than once (optimistic retry) or on a fallback store.
 */
export interface Step<R> {
  result: R;
  state?: IpState;
  remove?: boolean;
}

export interface AbuseStateStore {
  readonly kind: "memory" | "redis";
  /** Atomic read-modify-write of one key. `ttlFor` is how long (ms) the stored state must survive, if the store expires. */
  update<R>(
    key: string,
    ttlFor: (state: IpState) => number,
    fn: (current: IpState | null) => Step<R>,
  ): Promise<R>;
  get(key: string): Promise<IpState | null>;
  /** Number of states held in this process (memory store only). */
  readonly size?: number;
  /** Forget idle, harmless states (memory store only; Redis expires keys itself). */
  prune?(now: number): void;
  close?(): Promise<void>;
}

export interface MemoryRules {
  maxTracked: number;
  /** Brings the score up to date at `now` (decay). */
  settle(state: IpState, now: number): void;
  /** Idle and harmless: safe to forget. */
  forgettable(state: IpState, now: number): boolean;
}

/** In-process store: the behaviour of a single instance. `fn` runs synchronously, so every step is atomic. */
export class MemoryStateStore implements AbuseStateStore {
  readonly kind = "memory" as const;
  private readonly states = new Map<string, IpState>();

  constructor(private readonly rules: MemoryRules) {}

  get size(): number {
    return this.states.size;
  }

  update<R>(
    key: string,
    _ttlFor: (state: IpState) => number,
    fn: (current: IpState | null) => Step<R>,
  ): Promise<R> {
    try {
      const step = fn(this.states.get(key) ?? null);
      if (step.remove) this.states.delete(key);
      else if (step.state && this.states.get(key) !== step.state) {
        if (!this.states.has(key) && this.states.size >= this.rules.maxTracked)
          this.prune(step.state.lastSeen);
        this.states.set(key, step.state);
      }
      return Promise.resolve(step.result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  get(key: string): Promise<IpState | null> {
    return Promise.resolve(this.states.get(key) ?? null);
  }

  prune(now: number): void {
    for (const [key, s] of this.states) {
      this.rules.settle(s, now);
      if (this.rules.forgettable(s, now)) this.states.delete(key);
    }
    if (this.states.size >= this.rules.maxTracked) {
      const byAge = [...this.states.entries()]
        .filter(([, s]) => s.blockedUntil <= now)
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [key] of byAge.slice(0, this.states.size - this.rules.maxTracked + 1))
        this.states.delete(key);
    }
  }
}
