import { BlockList, isIP } from "node:net";

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

interface IpState {
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

export class AbuseDetector {
  private readonly states = new Map<string, IpState>();
  private readonly allow = new BlockList();
  private readonly opts: DetectorOptions;
  /** Blocks announced by `loadBlock` (operator or other instance) rather than decided here. */
  private readonly external = new Set<string>();

  constructor(
    options: Partial<DetectorOptions> = {},
    private readonly onEscalate: (event: Escalation) => void = () => undefined,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    for (const entry of this.opts.allowlist) this.addAllow(entry);
    if (this.opts.allowLoopback) {
      this.allow.addSubnet("127.0.0.0", 8, "ipv4");
      this.allow.addAddress("::1", "ipv6");
    }
  }

  // ------------------------------------------------------------------ before the request

  /** Decide what to do with a request from `ip`. `authenticated` means a valid access token was presented. */
  check(ip: string, authenticated: boolean, now: number): Decision {
    const key = normalize(ip);
    if (this.isAllowed(key)) return allow("NORMAL");
    const state = this.states.get(key);
    if (!state) return allow("NORMAL");
    state.lastSeen = now;
    const level = this.levelOf(state, now);

    if (authenticated) {
      // Valid tokens pass even from a banned address; only an absurd burst is slowed (never counted as abuse).
      const bucket = Math.floor(now / BUCKET_MS);
      if (state.authBucket !== bucket) {
        state.authBucket = bucket;
        state.authBucketCount = 0;
      }
      state.authBucketCount += 1;
      if (state.authBucketCount > this.opts.authBurstPer10s) {
        return { action: "throttle", level, retryAfterSeconds: 10, reason: "AUTHENTICATED_BURST" };
      }
      return allow(level);
    }

    if (level === "BLOCK") {
      return {
        action: "block",
        level,
        retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000)),
        reason: "TEMPORARILY_BLOCKED",
      };
    }
    if (level === "THROTTLE") {
      state.anonRecent = state.anonRecent.filter((t) => now - t < 60_000);
      if (state.anonRecent.length >= this.opts.throttlePerMinute) {
        const oldest = state.anonRecent[0] ?? now;
        return {
          action: "throttle",
          level,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
          reason: "THROTTLED",
        };
      }
      state.anonRecent.push(now);
    }
    return allow(level);
  }

  // ------------------------------------------------------------------ after the request

  /** A request arrived from `ip` (volume). Anonymous floods add points. */
  noteRequest(ip: string, authenticated: boolean, now: number): void {
    const key = normalize(ip);
    if (this.isAllowed(key) || authenticated) return;
    const state = this.stateFor(key, now);
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
    if (!state.anonBucketFlagged && state.anonBucketCount > this.opts.anonBurstPer10s) {
      state.anonBucketFlagged = true;
      state.anonBurstStreak += 1;
      this.add(key, state, "FLOOD", WEIGHTS.FLOOD_BUCKET, now);
      if (state.anonBurstStreak === SUSTAINED_BUCKETS) {
        this.add(key, state, "FLOOD_SUSTAINED", WEIGHTS.FLOOD_SUSTAINED, now);
      }
    }
  }

  /** A request finished with a notable outcome. */
  record(ip: string, signal: Signal, now: number): void {
    const key = normalize(ip);
    if (this.isAllowed(key)) return;
    const state = this.stateFor(key, now);
    switch (signal.type) {
      case "LOGIN_FAILURE": {
        this.add(key, state, "LOGIN_FAILURE", WEIGHTS.LOGIN_FAILURE, now);
        if (signal.username) {
          state.usernames.set(signal.username.toLowerCase(), now);
          for (const [name, at] of state.usernames)
            if (now - at > USERNAME_WINDOW_MS) state.usernames.delete(name);
          if (
            state.usernames.size >= USERNAMES_FOR_STUFFING &&
            now - state.stuffingAt > USERNAME_WINDOW_MS
          ) {
            state.stuffingAt = now;
            this.add(key, state, "CREDENTIAL_STUFFING", WEIGHTS.CREDENTIAL_STUFFING, now);
          }
        }
        break;
      }
      case "UNAUTHORIZED":
        this.add(key, state, "UNAUTHORIZED", WEIGHTS.UNAUTHORIZED, now);
        break;
      case "HONEYPOT":
        this.add(key, state, "HONEYPOT", WEIGHTS.HONEYPOT, now);
        break;
      case "NOT_FOUND": {
        // The same missing URL again and again is a broken link; many different ones is enumeration.
        const fresh =
          !state.paths.has(signal.path) ||
          now - (state.paths.get(signal.path) ?? 0) > PATH_WINDOW_MS;
        state.paths.set(signal.path, now);
        for (const [path, at] of state.paths)
          if (now - at > PATH_WINDOW_MS) state.paths.delete(path);
        if (fresh) this.add(key, state, "NOT_FOUND", WEIGHTS.NOT_FOUND, now);
        if (
          state.paths.size >= DISTINCT_PATHS_FOR_ENUMERATION &&
          now - state.enumerationAt > PATH_WINDOW_MS
        ) {
          state.enumerationAt = now;
          this.add(key, state, "PATH_ENUMERATION", WEIGHTS.PATH_ENUMERATION, now);
        }
        break;
      }
      case "BAD_REQUEST":
        this.add(key, state, "BAD_REQUEST", WEIGHTS.BAD_REQUEST, now);
        break;
      case "SCANNER_USER_AGENT":
        if (now - state.scannerAt > 3_600_000) {
          state.scannerAt = now;
          this.add(key, state, "SCANNER_USER_AGENT", WEIGHTS.SCANNER_USER_AGENT, now);
        }
        break;
      case "THROTTLED_HIT":
        this.add(key, state, "THROTTLED_HIT", WEIGHTS.THROTTLED_HIT, now);
        break;
    }
  }

  /** A normal authenticated request succeeded: lowers the score a little (shared addresses stay healthy). */
  recordAuthenticatedOk(ip: string, now: number): void {
    const key = normalize(ip);
    if (this.isAllowed(key)) return;
    const state = this.states.get(key);
    if (!state || state.score <= 0) return;
    this.decay(state, now);
    state.score = Math.max(0, state.score + WEIGHTS.AUTHENTICATED_OK);
  }

  // ------------------------------------------------------------------ blocks from outside (operator, restart, other instance)

  /** Applies a block that was decided elsewhere (stored ban, operator). `strikeEnds` are end times of earlier bans. */
  loadBlock(ip: string, until: number, strikeEnds: readonly number[] = []): void {
    const key = normalize(ip);
    const now = Date.now();
    const state = this.stateFor(key, now);
    state.blockedUntil = Math.max(state.blockedUntil, until);
    state.bans = [...new Set([...state.bans, ...strikeEnds])];
    this.external.add(key);
  }

  /** Lifts a block (operator); the address starts clean. */
  liftBlock(ip: string): void {
    const state = this.states.get(normalize(ip));
    if (!state) return;
    state.blockedUntil = 0;
    state.score = 0;
    state.anonRecent = [];
    this.external.delete(normalize(ip));
  }

  /** Addresses currently blocked, with their end time (for the sync with the store). */
  blocked(now: number): Array<{ ip: string; until: number }> {
    const out: Array<{ ip: string; until: number }> = [];
    for (const [ip, s] of this.states)
      if (s.blockedUntil > now) out.push({ ip, until: s.blockedUntil });
    return out;
  }

  /** Current state of one address (for tests and operators). */
  inspect(
    ip: string,
    now: number,
  ): { level: Level; score: number; strikes: number; blockedUntil: number } | null {
    const state = this.states.get(normalize(ip));
    if (!state) return null;
    this.decay(state, now);
    return {
      level: this.levelOf(state, now),
      score: Math.round(state.score * 10) / 10,
      strikes: this.recentBans(state, now).length,
      blockedUntil: state.blockedUntil,
    };
  }

  get tracked(): number {
    return this.states.size;
  }

  /** Forget idle, harmless addresses (called periodically and when the table is full). */
  prune(now: number): void {
    for (const [ip, s] of this.states) {
      this.decay(s, now);
      const idle = now - s.lastSeen > 10 * 60_000;
      const harmless = s.score < 1 && s.blockedUntil <= now && this.recentBans(s, now).length === 0;
      if (idle && harmless) this.states.delete(ip);
    }
    if (this.states.size >= this.opts.maxTrackedIps) {
      const byAge = [...this.states.entries()]
        .filter(([, s]) => s.blockedUntil <= now)
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [ip] of byAge.slice(0, this.states.size - this.opts.maxTrackedIps + 1))
        this.states.delete(ip);
    }
  }

  // ------------------------------------------------------------------ internals

  private add(ip: string, state: IpState, signal: string, points: number, now: number): void {
    this.decay(state, now);
    state.counts[signal] = (state.counts[signal] ?? 0) + 1;
    if (state.blockedUntil > now) return; // already banned: points would only prolong a decision already taken
    const before = this.levelOf(state, now);
    state.score = Math.max(0, state.score + points);
    if (state.score >= this.opts.banScore) {
      this.ban(ip, state, signal, now);
    } else if (before === "NORMAL" && state.score >= this.opts.throttleScore) {
      state.wasThrottled = true;
      this.onEscalate({
        type: "THROTTLE",
        ip,
        score: Math.round(state.score),
        strike: this.recentBans(state, now).length,
        until: 0,
        reason: signal,
        signals: { ...state.counts },
      });
    }
  }

  private ban(ip: string, state: IpState, reason: string, now: number): void {
    const recent = this.recentBans(state, now);
    const strike = recent.length + 1;
    const minutes = this.opts.banMinutes[Math.min(strike, this.opts.banMinutes.length) - 1] ?? 15;
    state.blockedUntil = now + minutes * 60_000;
    state.bans = [...recent, state.blockedUntil];
    const score = state.score;
    state.score = this.opts.scoreAfterBan;
    state.scoreAt = now;
    state.anonRecent = [];
    this.onEscalate({
      type: "BAN",
      ip,
      score: Math.round(score),
      strike,
      until: state.blockedUntil,
      reason,
      signals: { ...state.counts },
    });
  }

  private levelOf(state: IpState, now: number): Level {
    if (state.blockedUntil > now) return "BLOCK";
    this.decay(state, now);
    return state.score >= this.opts.throttleScore ? "THROTTLE" : "NORMAL";
  }

  private decay(state: IpState, now: number): void {
    if (now <= state.scoreAt) return;
    const halfLives = (now - state.scoreAt) / (this.opts.halfLifeMinutes * 60_000);
    state.score *= Math.pow(0.5, halfLives);
    if (state.score < 0.05) state.score = 0;
    state.scoreAt = now;
  }

  private recentBans(state: IpState, now: number): number[] {
    // Strikes are forgotten after a clean stretch counted from the END of the ban (a 24 h ban is not "old" the moment it ends).
    return state.bans.filter((end) => now - end < this.opts.strikeMemoryMinutes * 60_000);
  }

  private stateFor(ip: string, now: number): IpState {
    let state = this.states.get(ip);
    if (!state) {
      if (this.states.size >= this.opts.maxTrackedIps) this.prune(now);
      state = {
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
      this.states.set(ip, state);
    }
    state.lastSeen = now;
    return state;
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
