import { BlockList, isIP } from "node:net";
import {
  type AbuseStateStore,
  type IpState,
  MemoryStateStore,
  newIpState,
  type Step,
} from "./abuse-state";

/**
 * Behaviour-based abuse detection for client IPs. It judges WHAT an address does, not only how much: failed logins
 * across many usernames (credential stuffing), probing of well-known attack paths, enumeration of unknown URLs,
 * scanner user agents, malformed requests, ignoring a throttle and anonymous floods all add points to a score that
 * decays over time. Normal, authenticated traffic never adds points and lowers the score a little, so many employees
 * behind one carrier-grade NAT address are not punished for a single attacker's behaviour.
 *
 * Escalation: NORMAL -> THROTTLE (anonymous requests limited; authenticated traffic untouched) -> BLOCK (temporary
 * ban: anonymous requests refused with Retry-After; requests with a valid access token still pass). Repeat offenders
 * get longer bans (15 min, 1 h, 6 h, 24 h). Pure logic with an injected clock; persistence and HTTP are elsewhere.
 *
 * The rules below are written once, as steps `(state, event, now) -> new state`. WHERE the state lives is an
 * `AbuseStateStore`: process memory (default) or Redis shared by several API instances (abuse-redis.ts). A step is
 * applied atomically by the store, may be run again by it (so it has no side effects), and escalations are announced
 * only after the store has committed the step.
 */

export type Signal =
  /** A rejected login (wrong password / unknown user). `username` feeds the credential-stuffing check. */
  | { type: "LOGIN_FAILURE"; username?: string }
  /** 401/403 on anything else without a valid token. */
  | { type: "UNAUTHORIZED" }
  /** A request for a well-known attack target (/.env, /wp-login.php ...). */
  | { type: "HONEYPOT" }
  /** An unknown URL (`path` is the normalised path, used to count distinct ones). */
  | { type: "NOT_FOUND"; path: string }
  /** Malformed anonymous request (400, 413, 414, 415, 431). */
  | { type: "BAD_REQUEST" }
  | { type: "SCANNER_USER_AGENT" }
  /** A request that was refused or throttled and was repeated anyway. */
  | { type: "THROTTLED_HIT" };

export type Level = "NORMAL" | "THROTTLE" | "BLOCK";

export interface Decision {
  action: "allow" | "throttle" | "block";
  level: Level;
  retryAfterSeconds: number;
  reason: string | null;
}

export interface Escalation {
  type: "THROTTLE" | "BAN";
  ip: string;
  score: number;
  strike: number;
  /** Epoch ms when a ban ends (BAN only). */
  until: number;
  reason: string;
  signals: Record<string, number>;
}

export interface DetectorOptions {
  throttleScore: number;
  banScore: number;
  /** Anonymous requests per minute while throttled. */
  throttlePerMinute: number;
  /** Anonymous requests per 10 s that are flood-like. */
  anonBurstPer10s: number;
  /** Cap for authenticated requests per 10 s from one address (throttle only, never a ban). */
  authBurstPer10s: number;
  /** Minutes of ban for the 1st, 2nd, 3rd ... ban inside `strikeMemoryMinutes`; the last value repeats. */
  banMinutes: readonly number[];
  strikeMemoryMinutes: number;
  halfLifeMinutes: number;
  /** Score an address starts from after a ban ends (so a repeat is punished quickly). */
  scoreAfterBan: number;
  maxTrackedIps: number;
  allowlist: readonly string[];
  allowLoopback: boolean;
}

export const DEFAULT_OPTIONS: DetectorOptions = {
  throttleScore: 40,
  banScore: 100,
  throttlePerMinute: 20,
  anonBurstPer10s: 100,
  authBurstPer10s: 400,
  banMinutes: [15, 60, 360, 1440],
  strikeMemoryMinutes: 7 * 1440,
  halfLifeMinutes: 10,
  scoreAfterBan: 35,
  maxTrackedIps: 50_000,
  allowlist: [],
  allowLoopback: true,
};

/** Points per signal. Behaviour that only attackers show weighs most. */
export const WEIGHTS = {
  LOGIN_FAILURE: 8,
  /** Many different usernames failing from one address in a short time: not a forgetful user. */
  CREDENTIAL_STUFFING: 45,
  UNAUTHORIZED: 3,
  HONEYPOT: 60,
  NOT_FOUND: 3,
  /** Many distinct unknown URLs in a minute: path enumeration. */
  PATH_ENUMERATION: 35,
  BAD_REQUEST: 2,
  SCANNER_USER_AGENT: 25,
  THROTTLED_HIT: 2,
  /** One flood-like 10 s bucket of anonymous requests; sustained buckets weigh more. */
  FLOOD_BUCKET: 10,
  FLOOD_SUSTAINED: 40,
  /** Each successful authenticated request lowers the score. */
  AUTHENTICATED_OK: -1,
} as const;

const USERNAME_WINDOW_MS = 5 * 60_000;
const USERNAMES_FOR_STUFFING = 5;
const PATH_WINDOW_MS = 60_000;
const DISTINCT_PATHS_FOR_ENUMERATION = 15;
const BUCKET_MS = 10_000;
const SUSTAINED_BUCKETS = 3;

/** What a step needs besides the state: the options, and where it announces escalations (emitted after commit). */
interface Ctx {
  opts: DetectorOptions;
  events: Escalation[];
}

// ------------------------------------------------------------------ the rules (state, event, now) -> state

function levelOf(c: Ctx, state: IpState, now: number): Level {
  if (state.blockedUntil > now) return "BLOCK";
  decay(c.opts, state, now);
  return state.score >= c.opts.throttleScore ? "THROTTLE" : "NORMAL";
}

function decay(opts: DetectorOptions, state: IpState, now: number): void {
  if (now <= state.scoreAt) return;
  const halfLives = (now - state.scoreAt) / (opts.halfLifeMinutes * 60_000);
  state.score *= Math.pow(0.5, halfLives);
  if (state.score < 0.05) state.score = 0;
  state.scoreAt = now;
}

function recentBans(opts: DetectorOptions, state: IpState, now: number): number[] {
  // Strikes are forgotten after a clean stretch counted from the END of the ban (a 24 h ban is not "old" the moment it ends).
  return state.bans.filter((end) => now - end < opts.strikeMemoryMinutes * 60_000);
}

function add(
  c: Ctx,
  ip: string,
  state: IpState,
  signal: string,
  points: number,
  now: number,
): void {
  decay(c.opts, state, now);
  state.counts[signal] = (state.counts[signal] ?? 0) + 1;
  if (state.blockedUntil > now) return; // already banned: points would only prolong a decision already taken
  const before = levelOf(c, state, now);
  state.score = Math.max(0, state.score + points);
  if (state.score >= c.opts.banScore) {
    ban(c, ip, state, signal, now);
  } else if (before === "NORMAL" && state.score >= c.opts.throttleScore) {
    state.wasThrottled = true;
    c.events.push({
      type: "THROTTLE",
      ip,
      score: Math.round(state.score),
      strike: recentBans(c.opts, state, now).length,
      until: 0,
      reason: signal,
      signals: { ...state.counts },
    });
  }
}

function ban(c: Ctx, ip: string, state: IpState, reason: string, now: number): void {
  const recent = recentBans(c.opts, state, now);
  const strike = recent.length + 1;
  const minutes = c.opts.banMinutes[Math.min(strike, c.opts.banMinutes.length) - 1] ?? 15;
  state.blockedUntil = now + minutes * 60_000;
  state.bans = [...recent, state.blockedUntil];
  const score = state.score;
  state.score = c.opts.scoreAfterBan;
  state.scoreAt = now;
  state.anonRecent = [];
  c.events.push({
    type: "BAN",
    ip,
    score: Math.round(score),
    strike,
    until: state.blockedUntil,
    reason,
    signals: { ...state.counts },
  });
}

/** The state of an address, created on first use. */
function stateFor(current: IpState | null, now: number): IpState {
  const state = current ?? newIpState(now);
  state.lastSeen = now;
  return state;
}

/** `check`: what to do with a request. Returns whether the state must be stored (it changed in a way that matters). */
function checkRule(
  c: Ctx,
  state: IpState | null,
  authenticated: boolean,
  now: number,
): { decision: Decision; dirty: boolean } {
  if (!state) return { decision: allow("NORMAL"), dirty: false };
  state.lastSeen = now;
  const level = levelOf(c, state, now);

  if (authenticated) {
    // Valid tokens pass even from a banned address; only an absurd burst is slowed (never counted as abuse).
    const bucket = Math.floor(now / BUCKET_MS);
    if (state.authBucket !== bucket) {
      state.authBucket = bucket;
      state.authBucketCount = 0;
    }
    state.authBucketCount += 1;
    if (state.authBucketCount > c.opts.authBurstPer10s) {
      return {
        decision: {
          action: "throttle",
          level,
          retryAfterSeconds: 10,
          reason: "AUTHENTICATED_BURST",
        },
        dirty: true,
      };
    }
    return { decision: allow(level), dirty: true };
  }

  if (level === "BLOCK") {
    return {
      decision: {
        action: "block",
        level,
        retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)),
        reason: "TEMPORARILY_BLOCKED",
      },
      dirty: false,
    };
  }
  let dirty = false;
  if (level === "THROTTLE") {
    state.anonRecent = state.anonRecent.filter((t) => now - t < 60_000);
    dirty = true;
    if (state.anonRecent.length >= c.opts.throttlePerMinute) {
      const oldest = state.anonRecent[0] ?? now;
      return {
        decision: {
          action: "throttle",
          level,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
          reason: "THROTTLED",
        },
        dirty,
      };
    }
    state.anonRecent.push(now);
  }
  return { decision: allow(level), dirty };
}

/** `noteRequest`: volume of anonymous requests. Returns the state to store, or null when nothing is to be kept. */
function noteRule(
  c: Ctx,
  ip: string,
  current: IpState | null,
  authenticated: boolean,
  now: number,
): IpState | null {
  if (authenticated) return null;
  const state = stateFor(current, now);
  const bucket = Math.floor(now / BUCKET_MS);
  if (state.anonBucket !== bucket) {
    // A new bucket: was the previous one part of an unbroken flood?
    if (state.anonBucket !== 0 && !(state.anonBucketFlagged && bucket === state.anonBucket + 1)) {
      state.anonBurstStreak = 0;
    }
    state.anonBucket = bucket;
    state.anonBucketCount = 0;
    state.anonBucketFlagged = false;
  }
  state.anonBucketCount += 1;
  if (!state.anonBucketFlagged && state.anonBucketCount > c.opts.anonBurstPer10s) {
    state.anonBucketFlagged = true;
    state.anonBurstStreak += 1;
    add(c, ip, state, "FLOOD", WEIGHTS.FLOOD_BUCKET, now);
    if (state.anonBurstStreak === SUSTAINED_BUCKETS) {
      add(c, ip, state, "FLOOD_SUSTAINED", WEIGHTS.FLOOD_SUSTAINED, now);
    }
  }
  return state;
}

/** `record`: a finished request with a notable outcome. */
function recordRule(
  c: Ctx,
  ip: string,
  current: IpState | null,
  signal: Signal,
  now: number,
): IpState {
  const state = stateFor(current, now);
  switch (signal.type) {
    case "LOGIN_FAILURE": {
      add(c, ip, state, "LOGIN_FAILURE", WEIGHTS.LOGIN_FAILURE, now);
      if (signal.username) {
        state.usernames.set(signal.username.toLowerCase(), now);
        for (const [name, at] of state.usernames)
          if (now - at > USERNAME_WINDOW_MS) state.usernames.delete(name);
        if (
          state.usernames.size >= USERNAMES_FOR_STUFFING &&
          now - state.stuffingAt > USERNAME_WINDOW_MS
        ) {
          state.stuffingAt = now;
          add(c, ip, state, "CREDENTIAL_STUFFING", WEIGHTS.CREDENTIAL_STUFFING, now);
        }
      }
      break;
    }
    case "UNAUTHORIZED":
      add(c, ip, state, "UNAUTHORIZED", WEIGHTS.UNAUTHORIZED, now);
      break;
    case "HONEYPOT":
      add(c, ip, state, "HONEYPOT", WEIGHTS.HONEYPOT, now);
      break;
    case "NOT_FOUND": {
      // The same missing URL again and again is a broken link; many different ones is enumeration.
      const fresh =
        !state.paths.has(signal.path) || now - (state.paths.get(signal.path) ?? 0) > PATH_WINDOW_MS;
      state.paths.set(signal.path, now);
      for (const [path, at] of state.paths) if (now - at > PATH_WINDOW_MS) state.paths.delete(path);
      if (fresh) add(c, ip, state, "NOT_FOUND", WEIGHTS.NOT_FOUND, now);
      if (
        state.paths.size >= DISTINCT_PATHS_FOR_ENUMERATION &&
        now - state.enumerationAt > PATH_WINDOW_MS
      ) {
        state.enumerationAt = now;
        add(c, ip, state, "PATH_ENUMERATION", WEIGHTS.PATH_ENUMERATION, now);
      }
      break;
    }
    case "BAD_REQUEST":
      add(c, ip, state, "BAD_REQUEST", WEIGHTS.BAD_REQUEST, now);
      break;
    case "SCANNER_USER_AGENT":
      if (now - state.scannerAt > 3_600_000) {
        state.scannerAt = now;
        add(c, ip, state, "SCANNER_USER_AGENT", WEIGHTS.SCANNER_USER_AGENT, now);
      }
      break;
    case "THROTTLED_HIT":
      add(c, ip, state, "THROTTLED_HIT", WEIGHTS.THROTTLED_HIT, now);
      break;
  }
  return state;
}

/** How long (ms) a state must be remembered: the score fades in ~2 h, a strike counts for a week after its ban ended. */
export function ttlMsFor(opts: DetectorOptions, state: IpState, now: number): number {
  const base = 2 * 3_600_000;
  const lastBanEnd = state.bans.reduce((m, end) => Math.max(m, end), 0);
  const strikes = lastBanEnd > 0 ? lastBanEnd + opts.strikeMemoryMinutes * 60_000 - now : 0;
  return Math.ceil(Math.max(base, strikes, state.blockedUntil - now));
}

const settle = (opts: DetectorOptions, state: IpState, now: number): void =>
  decay(opts, state, now);

const forgettable = (opts: DetectorOptions, s: IpState, now: number): boolean => {
  const idle = now - s.lastSeen > 10 * 60_000;
  const harmless = s.score < 1 && s.blockedUntil <= now && recentBans(opts, s, now).length === 0;
  return idle && harmless;
};

/** The in-process store with this detector's eviction rules (the default, and the fallback when Redis is unavailable). */
export function createMemoryStore(options: Partial<DetectorOptions> = {}): MemoryStateStore {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return new MemoryStateStore({
    maxTracked: opts.maxTrackedIps,
    settle: (s, now) => settle(opts, s, now),
    forgettable: (s, now) => forgettable(opts, s, now),
  });
}

// ------------------------------------------------------------------ the detector

export class AbuseDetector {
  private readonly allow = new BlockList();
  private readonly opts: DetectorOptions;
  readonly store: AbuseStateStore;

  constructor(
    options: Partial<DetectorOptions> = {},
    private readonly onEscalate: (event: Escalation) => void = () => undefined,
    store?: AbuseStateStore,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.store = store ?? createMemoryStore(options);
    for (const entry of this.opts.allowlist) this.addAllow(entry);
    if (this.opts.allowLoopback) {
      this.allow.addSubnet("127.0.0.0", 8, "ipv4");
      this.allow.addAddress("::1", "ipv6");
    }
  }

  // ------------------------------------------------------------------ before the request

  /** Decide what to do with a request from `ip`. `authenticated` means a valid access token was presented. */
  async check(ip: string, authenticated: boolean, now: number): Promise<Decision> {
    const key = normalize(ip);
    if (this.isAllowed(key)) return allow("NORMAL");
    return this.apply(key, now, (current, c) => {
      const { decision, dirty } = checkRule(c, current, authenticated, now);
      return { result: decision, ...(dirty && current ? { state: current } : {}) };
    });
  }

  /** A request arrived from `ip` (volume). Anonymous floods add points. */
  async noteRequest(ip: string, authenticated: boolean, now: number): Promise<void> {
    const key = normalize(ip);
    if (this.isAllowed(key) || authenticated) return;
    await this.apply(key, now, (current, c) => ({
      result: undefined,
      state: noteRule(c, key, current, false, now) ?? undefined,
    }));
  }

  /**
   * `check` + `noteRequest` (+ `THROTTLED_HIT` when an anonymous request is refused) as ONE atomic step: what the
   * middleware does for every request, in a single round trip to a shared store.
   */
  async admit(ip: string, authenticated: boolean, now: number): Promise<Decision> {
    const key = normalize(ip);
    if (this.isAllowed(key)) return allow("NORMAL");
    return this.apply(key, now, (current, c) => {
      const { decision, dirty } = checkRule(c, current, authenticated, now);
      let state = current;
      let changed = dirty && current !== null;
      if (!authenticated) {
        state = noteRule(c, key, current, false, now);
        changed = true;
        if (decision.action !== "allow")
          state = recordRule(c, key, state, { type: "THROTTLED_HIT" }, now);
      }
      return { result: decision, ...(changed && state ? { state } : {}) };
    });
  }

  // ------------------------------------------------------------------ after the request

  /** A request finished with a notable outcome. */
  async record(ip: string, signal: Signal, now: number): Promise<void> {
    const key = normalize(ip);
    if (this.isAllowed(key)) return;
    await this.apply(key, now, (current, c) => ({
      result: undefined,
      state: recordRule(c, key, current, signal, now),
    }));
  }

  /** A normal authenticated request succeeded: lowers the score a little (shared addresses stay healthy). */
  async recordAuthenticatedOk(ip: string, now: number): Promise<void> {
    const key = normalize(ip);
    if (this.isAllowed(key)) return;
    await this.apply(key, now, (state, c) => {
      if (!state || state.score <= 0) return { result: undefined };
      decay(c.opts, state, now);
      state.score = Math.max(0, state.score + WEIGHTS.AUTHENTICATED_OK);
      return { result: undefined, state };
    });
  }

  // ------------------------------------------------------------------ blocks from outside (operator, restart, other instance)

  /** Applies a block that was decided elsewhere (stored ban, operator). `strikeEnds` are end times of earlier bans. */
  async loadBlock(
    ip: string,
    until: number,
    strikeEnds: readonly number[] = [],
    now: number = Date.now(),
  ): Promise<void> {
    const key = normalize(ip);
    await this.apply(key, now, (current) => {
      const state = stateFor(current, now);
      const blockedUntil = Math.max(state.blockedUntil, until);
      const bans = [...new Set([...state.bans, ...strikeEnds])];
      const changed =
        current === null ||
        blockedUntil !== state.blockedUntil ||
        bans.length !== state.bans.length;
      state.blockedUntil = blockedUntil;
      state.bans = bans;
      return { result: undefined, ...(changed ? { state } : {}) };
    });
  }

  /** Lifts a block (operator); the address starts clean (its earlier strikes stay). */
  async liftBlock(ip: string, now: number = Date.now()): Promise<void> {
    await this.apply(normalize(ip), now, (state) => {
      if (!state) return { result: undefined };
      state.blockedUntil = 0;
      state.score = 0;
      state.anonRecent = [];
      return state.bans.length === 0
        ? { result: undefined, remove: true }
        : { result: undefined, state };
    });
  }

  /** Current state of one address (for tests and operators). */
  async inspect(
    ip: string,
    now: number,
  ): Promise<{ level: Level; score: number; strikes: number; blockedUntil: number } | null> {
    const state = await this.store.get(normalize(ip));
    if (!state) return null;
    const c = { opts: this.opts, events: [] };
    decay(this.opts, state, now);
    return {
      level: levelOf(c, state, now),
      score: Math.round(state.score * 10) / 10,
      strikes: recentBans(this.opts, state, now).length,
      blockedUntil: state.blockedUntil,
    };
  }

  /** States held in this process (0 for a store that lives elsewhere). */
  get tracked(): number {
    return this.store.size ?? 0;
  }

  /** Forget idle, harmless addresses held in this process (called periodically and when the table is full). */
  prune(now: number): void {
    this.store.prune?.(now);
  }

  // ------------------------------------------------------------------ internals

  /** Runs one rule step atomically on the store; announces what it escalated only after the store committed. */
  private async apply<R>(
    key: string,
    now: number,
    body: (current: IpState | null, c: Ctx) => Step<R>,
  ): Promise<R> {
    const events: Escalation[] = [];
    const c: Ctx = { opts: this.opts, events };
    const result = await this.store.update(
      key,
      (state) => ttlMsFor(this.opts, state, now),
      (current) => {
        events.length = 0; // the store may run a step again
        return body(current, c);
      },
    );
    for (const event of events) this.onEscalate(event);
    return result;
  }

  private isAllowed(ip: string): boolean {
    const family = isIP(ip);
    if (family === 0) return false;
    return this.allow.check(ip, family === 4 ? "ipv4" : "ipv6");
  }

  private addAllow(entry: string): void {
    const [address, prefix] = entry.trim().split("/");
    if (!address) return;
    const family = isIP(address);
    if (family === 0) throw new Error(`ABUSE_ALLOWLIST: "${entry}" is not an IP address or CIDR`);
    const kind = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) this.allow.addAddress(address, kind);
    else this.allow.addSubnet(address, Number(prefix), kind);
  }
}

const allow = (level: Level): Decision => ({
  action: "allow",
  level,
  retryAfterSeconds: 0,
  reason: null,
});

/** `::ffff:203.0.113.5` (IPv4 seen by a dual-stack socket) and `203.0.113.5` are the same client. */
export function normalize(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}
