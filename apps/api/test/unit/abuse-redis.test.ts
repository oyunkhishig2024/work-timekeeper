import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AbuseDetector,
  createMemoryStore,
  DEFAULT_OPTIONS,
  type DetectorOptions,
  type Escalation,
} from "../../src/security/abuse-detector";
import {
  createSharedStore,
  RedisStateStore,
  createRedisClient,
} from "../../src/security/abuse-redis";
import { AbuseService } from "../../src/security/abuse.service";
import { loadConfig } from "../../src/common/config";
import { SystemClock } from "../../src/common/clock";
import type { IpBlockStore } from "../../src/security/ip-block.store";
import { newIpState } from "../../src/security/abuse-state";
import { hasRedis, startRedis, type TestRedis } from "../redis-server";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const IP = "203.0.113.7";

/** Real redis-server (throwaway, random port). Skipped with a message when the binary is missing. */
describe.skipIf(!hasRedis)("abuse state shared through Redis (real redis-server)", () => {
  let redis: TestRedis;
  let prefixCounter = 0;
  const open: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    redis = await startRedis();
  });
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });
  afterAll(async () => {
    await redis.stop();
  });

  const freshPrefix = () => `test${++prefixCounter}:abuse:`;

  /** One "API instance": its own connection, its own memory fallback, one detector. */
  async function instance(
    prefix: string,
    detectorOptions: Partial<DetectorOptions> = {},
    breaker: { timeoutMs?: number; failures?: number; cooldownMs?: number } = {},
  ) {
    const events: Escalation[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const memory = createMemoryStore(detectorOptions);
    const shared = createSharedStore(memory, {
      url: redis.url,
      prefix,
      timeoutMs: breaker.timeoutMs ?? 500,
      failures: breaker.failures ?? 3,
      cooldownMs: breaker.cooldownMs ?? 10_000,
      log: (line) => logs.push(line),
    });
    const detector = new AbuseDetector(detectorOptions, (e) => events.push(e), shared.store);
    await shared.connect(2000);
    open.push(() => shared.store.close());
    return { detector, events, logs, store: shared.store, memory };
  }

  /** A raw client for looking at what is stored. */
  function raw() {
    const client = new Redis(redis.url);
    open.push(async () => {
      client.disconnect();
    });
    return client;
  }

  const trio = async (prefix: string, options: Partial<DetectorOptions> = {}) =>
    Promise.all([instance(prefix, options), instance(prefix, options), instance(prefix, options)]);

  it("three instances that each see a third of an attack reach a ban that none would reach alone", async () => {
    const prefix = freshPrefix();
    const [a, b, c] = await trio(prefix);

    // Honeypot probes: 2 are needed for a ban (60 points each); each instance sees one.
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    expect((await b.detector.inspect(IP, T0))?.level).toBe("THROTTLE");
    await b.detector.record(IP, { type: "HONEYPOT" }, T0 + 1000);
    expect(await c.detector.check(IP, false, T0 + 2000)).toMatchObject({
      action: "block",
      level: "BLOCK",
    });
    const bans = [a, b, c].flatMap((i) => i.events.filter((e) => e.type === "BAN"));
    expect(bans).toHaveLength(1);
    expect(bans[0]).toMatchObject({ strike: 1, reason: "HONEYPOT" });
    expect(b.events.map((e) => e.type)).toEqual(["BAN"]); // announced by the instance that decided it, once

    // The same probes on three UNSHARED instances: nobody reaches the ban.
    const alone = ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map(() => {
      const events: Escalation[] = [];
      return { detector: new AbuseDetector({}, (e) => events.push(e)), events };
    });
    for (const [i, one] of alone.entries())
      await one.detector.record("198.51.100.9", { type: "HONEYPOT" }, T0 + i);
    expect(alone.flatMap((x) => x.events).some((e) => e.type === "BAN")).toBe(false);
  });

  it("credential stuffing is seen across instances (username set), path enumeration too (distinct-path set)", async () => {
    const [a, b, c] = await trio(freshPrefix());
    // 5 distinct usernames, 2 + 2 + 1 per instance: only together do they make "stuffing"
    await a.detector.record(IP, { type: "LOGIN_FAILURE", username: "u1" }, T0);
    await a.detector.record(IP, { type: "LOGIN_FAILURE", username: "u2" }, T0 + 1);
    await b.detector.record(IP, { type: "LOGIN_FAILURE", username: "u3" }, T0 + 2);
    await b.detector.record(IP, { type: "LOGIN_FAILURE", username: "u4" }, T0 + 3);
    expect([a, b, c].flatMap((i) => i.events)).toHaveLength(0); // 4 x 8 = 32 points
    await c.detector.record(IP, { type: "LOGIN_FAILURE", username: "u5" }, T0 + 4);
    expect(c.events.map((e) => e.type)).toEqual(["THROTTLE"]);
    expect(c.events[0]!.signals).toMatchObject({ LOGIN_FAILURE: 5 });
    expect((await a.store.get(IP))?.counts.CREDENTIAL_STUFFING).toBe(1);
    expect((await a.detector.inspect(IP, T0 + 4))?.score).toBe(85); // 5 x 8 + 45

    // 15 distinct unknown URLs, 5 per instance
    const other = "203.0.113.50";
    for (let i = 0; i < 15; i++)
      await [a, b, c][i % 3]!.detector.record(
        other,
        { type: "NOT_FOUND", path: `/probe-${i}` },
        T0 + i * 100,
      );
    expect((await c.store.get(other))?.counts.PATH_ENUMERATION).toBe(1);

    // an anonymous flood split over instances: the 10 s bucket is shared
    const flooder = "203.0.113.51";
    const opts = { anonBurstPer10s: 60 };
    const [x, y, z] = await trio(freshPrefix(), opts);
    for (let i = 0; i < 90; i++)
      await [x, y, z][i % 3]!.detector.noteRequest(flooder, false, T0 + i * 10);
    expect([x, y, z].flatMap((i) => i.events)).toHaveLength(0); // 90 > 60 -> one FLOOD bucket = 10 points: below the throttle
    expect((await z.detector.inspect(flooder, T0 + 900))?.score).toBe(10);
  });

  it("a ban decided by one instance is enforced by the others at once (no database sync involved)", async () => {
    const [a, b] = await trio(freshPrefix());
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    const decision = await b.detector.check(IP, false, T0 + 5000);
    expect(decision).toMatchObject({ action: "block", reason: "TEMPORARILY_BLOCKED" });
    expect(decision.retryAfterSeconds).toBe(Math.ceil((15 * MIN - 4999) / 1000));
    // admit (what the middleware calls) also refuses on the other instance and counts the ignored limit
    const admitted = await b.detector.admit(IP, false, T0 + 6000);
    expect(admitted.action).toBe("block");
    expect((await a.detector.inspect(IP, T0 + 6000))?.level).toBe("BLOCK");
    // signed-in people pass on every instance
    expect((await b.detector.admit(IP, true, T0 + 6000)).action).toBe("allow");
    // and the ban ends everywhere by the clock
    expect((await b.detector.check(IP, false, T0 + 1 + 15 * MIN + 1)).action).not.toBe("block");
  });

  it("is exactly atomic: concurrent records from several instances lose no update", async () => {
    // thresholds out of reach so only the arithmetic is observed
    const options = { throttleScore: 1e9, banScore: 2e9, anonBurstPer10s: 1e6 };
    const prefix = freshPrefix();
    const instances = await Promise.all([1, 2, 3, 4].map(() => instance(prefix, options)));
    const per = 50;
    const jobs: Array<Promise<void>> = [];
    for (const inst of instances) {
      for (let i = 0; i < per; i++) {
        jobs.push(inst.detector.record(IP, { type: "UNAUTHORIZED" }, T0));
        jobs.push(inst.detector.noteRequest(IP, false, T0));
        jobs.push(inst.detector.record(IP, { type: "LOGIN_FAILURE", username: `n${i % 7}` }, T0));
      }
    }
    await Promise.all(jobs);
    const n = instances.length * per; // 200
    const state = await instances[0]!.store.get(IP);
    expect(state?.counts.UNAUTHORIZED).toBe(n);
    expect(state?.counts.LOGIN_FAILURE).toBe(n);
    expect(state?.anonBucketCount).toBe(n);
    expect(state?.counts.CREDENTIAL_STUFFING).toBe(1); // 7 distinct names, counted once
    expect(state?.score).toBe(n * 3 + n * 8 + 45); // exact, no decay (same instant)
    expect(state?.usernames.size).toBe(7);
    // everything also went through the shared store, not the local fallback
    expect(instances.every((i) => i.logs.length === 0 && (i.memory.size ?? 0) === 0)).toBe(true);
  });

  it("decides a ban exactly once when many instances cross the threshold at the same moment", async () => {
    const prefix = freshPrefix();
    const instances = await Promise.all([1, 2, 3].map(() => instance(prefix)));
    await Promise.all(
      instances.flatMap((inst) =>
        Array.from({ length: 20 }, () => inst.detector.record(IP, { type: "HONEYPOT" }, T0)),
      ),
    );
    const events = instances.flatMap((i) => i.events);
    expect(events.filter((e) => e.type === "BAN")).toHaveLength(1);
    const state = await instances[0]!.store.get(IP);
    expect(state?.bans).toHaveLength(1);
    expect(state?.counts.HONEYPOT).toBe(60); // points after the ban are not added, but every signal is counted
  });

  it("decays with the injected clock and expires in Redis (TTL)", async () => {
    const prefix = freshPrefix();
    const [a, b] = await trio(prefix);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    expect((await b.detector.inspect(IP, T0))?.level).toBe("THROTTLE");
    expect((await b.detector.inspect(IP, T0 + 10 * MIN))?.score).toBe(30); // one half-life, same as in memory
    expect((await b.detector.inspect(IP, T0 + 10 * MIN))?.level).toBe("NORMAL");
    expect((await a.detector.inspect(IP, T0 + 60 * MIN))!.score).toBeLessThan(1);

    // TTLs: a score is remembered for 2 h, a ban for its length + a week of strike memory
    const client = raw();
    const ttl = await client.pttl(prefix + IP);
    expect(ttl).toBeGreaterThan(2 * 3_600_000 - 5000);
    expect(ttl).toBeLessThanOrEqual(2 * 3_600_000);
    await a.detector.record("203.0.113.9", { type: "HONEYPOT" }, T0);
    await a.detector.record("203.0.113.9", { type: "HONEYPOT" }, T0 + 1);
    const banTtl = await client.pttl(prefix + "203.0.113.9");
    const expected = 15 * MIN + 7 * 24 * 60 * MIN;
    expect(banTtl).toBeGreaterThan(expected - 5000);
    expect(banTtl).toBeLessThanOrEqual(expected);

    // real expiry (the only place where real time is needed): a state written with a 150 ms lifetime disappears
    const expiring = createRedisClient(redis.url, 500);
    const store = new RedisStateStore(expiring, { prefix, timeoutMs: 500 });
    open.push(() => store.close());
    await expiring.connect();
    await store.update(
      "short-lived",
      () => 150,
      () => ({ result: 1, state: newIpState(T0) }),
    );
    expect(await store.get("short-lived")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(await store.get("short-lived")).toBeNull();
  });

  it("an operator lift clears the shared state for every instance", async () => {
    const prefix = freshPrefix();
    const [a, b] = await trio(prefix);
    const client = raw();
    // a manual block (no strikes) is removed entirely
    await a.detector.loadBlock("203.0.113.20", T0 + 30 * MIN, [], T0);
    expect((await b.detector.check("203.0.113.20", false, T0 + 1)).action).toBe("block");
    await b.detector.liftBlock("203.0.113.20", T0 + 2);
    expect((await a.detector.check("203.0.113.20", false, T0 + 3)).action).toBe("allow");
    expect(await client.exists(prefix + "203.0.113.20")).toBe(0);

    // a ban decided by the detector: blocked state and score are cleared, the strike is kept
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    expect((await b.detector.check(IP, false, T0 + 2)).action).toBe("block");
    await b.detector.liftBlock(IP, T0 + 3);
    expect((await a.detector.check(IP, false, T0 + 4)).action).toBe("allow");
    expect(await a.detector.inspect(IP, T0 + 4)).toMatchObject({
      score: 0,
      strikes: 1,
      level: "NORMAL",
    });
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1000);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1001);
    expect(a.events.filter((e) => e.type === "BAN").at(-1)).toMatchObject({ strike: 2 });
  });

  it("loadBlock from the database reaches every instance (and does not write when nothing changed)", async () => {
    const prefix = freshPrefix();
    const [a, b] = await trio(prefix);
    await a.detector.loadBlock(IP, T0 + 30 * MIN, [T0 - 5 * MIN], T0);
    expect((await b.detector.check(IP, false, T0 + 1)).action).toBe("block");
    const client = raw();
    const before = await client.hget(prefix + IP, "v");
    await b.detector.loadBlock(IP, T0 + 30 * MIN, [T0 - 5 * MIN], T0 + 10);
    expect(await client.hget(prefix + IP, "v")).toBe(before);
  });

  it("allowlisted addresses, loopback and signed-in traffic are exempt and leave nothing in Redis", async () => {
    const prefix = freshPrefix();
    const options = { allowlist: ["198.51.100.0/24"] };
    const [a, b] = await trio(prefix, options);
    const client = raw();
    for (const ip of ["198.51.100.20", "127.0.0.1", "::1"]) {
      for (let i = 0; i < 5; i++) await a.detector.record(ip, { type: "HONEYPOT" }, T0 + i);
      await b.detector.noteRequest(ip, false, T0);
      expect((await b.detector.admit(ip, false, T0 + 10)).action).toBe("allow");
    }
    expect(a.events).toHaveLength(0);
    expect(await client.keys(prefix + "*")).toEqual([]);

    // signed-in requests never add points or create state; they pass from a banned address on any instance
    await b.detector.noteRequest(IP, true, T0);
    await b.detector.admit("203.0.113.30", true, T0);
    expect(await client.keys(prefix + "*")).toEqual([]);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    expect((await b.detector.check(IP, true, T0 + 2)).action).toBe("allow");
    expect((await b.detector.check(IP, false, T0 + 2)).action).toBe("block");
    // a signed-in request lowers the shared score
    await a.detector.record("203.0.113.31", { type: "UNAUTHORIZED" }, T0);
    await b.detector.recordAuthenticatedOk("203.0.113.31", T0);
    expect((await a.detector.inspect("203.0.113.31", T0))?.score).toBe(2);
  });

  it("authenticated bursts are slowed across instances, never counted as abuse", async () => {
    const [a, b] = await trio(freshPrefix(), { authBurstPer10s: 20 });
    await a.detector.record(IP, { type: "UNAUTHORIZED" }, T0);
    let throttled = 0;
    for (let i = 0; i < 60; i++)
      if ((await [a, b][i % 2]!.detector.check(IP, true, T0 + 100 + i * 10)).action === "throttle")
        throttled++;
    expect(throttled).toBe(40);
    expect(a.events.concat(b.events)).toHaveLength(0);
  });

  it("two prefixes on one Redis do not see each other", async () => {
    const [a] = await trio(freshPrefix());
    const [b] = await trio(freshPrefix());
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    expect((await a.detector.check(IP, false, T0 + 2)).action).toBe("block");
    expect((await b.detector.check(IP, false, T0 + 2)).action).toBe("allow");
    expect(await b.detector.inspect(IP, T0 + 2)).toBeNull();
  });

  it("uses at most two Redis round trips for a request: one read, one compare-and-set", async () => {
    const prefix = freshPrefix();
    const a = await instance(prefix);
    const client = (
      a.store as unknown as { primary: { client: Record<string, (...args: unknown[]) => unknown> } }
    ).primary.client;
    let calls = 0;
    for (const name of ["hmget", "abuseCas", "del"]) {
      const original = client[name]!.bind(client);
      client[name] = (...args: unknown[]) => {
        calls++;
        return original(...args);
      };
    }
    // anonymous request from an address with no history: read + create
    await a.detector.admit(IP, false, T0);
    expect(calls).toBe(2);
    // signed-in request from an address with no state: a single read
    calls = 0;
    await a.detector.admit("203.0.113.77", true, T0);
    expect(calls).toBe(1);
    // refused (banned) anonymous request: still one read + one write (ignored-limit hit included)
    await a.detector.record(IP, { type: "HONEYPOT" }, T0);
    await a.detector.record(IP, { type: "HONEYPOT" }, T0 + 1);
    calls = 0;
    expect((await a.detector.admit(IP, false, T0 + 2)).action).toBe("block");
    expect(calls).toBe(2);
    // a burst of concurrent requests of one address shares round trips (batched)
    calls = 0;
    await Promise.all(Array.from({ length: 50 }, () => a.detector.admit(IP, false, T0 + 3)));
    expect(calls).toBeLessThan(10);
  });

  describe("when Redis is unavailable", () => {
    it("keeps serving from memory (fail open), logs once per state change, and recovers", async () => {
      const prefix = freshPrefix();
      const a = await instance(prefix, {}, { timeoutMs: 150, failures: 2, cooldownMs: 400 });
      const b = await instance(prefix, {}, { timeoutMs: 150, failures: 2, cooldownMs: 400 });
      await a.detector.record(IP, { type: "HONEYPOT" }, T0);
      expect((await b.detector.inspect(IP, T0))?.level).toBe("THROTTLE");

      await redis.kill();
      const t = Date.now();
      // unknown address, no shared state reachable: allowed, and the first calls come back quickly
      for (let i = 0; i < 6; i++) {
        const d = await a.detector.admit("203.0.113.40", false, T0 + i);
        expect(d.action).toBe("allow");
      }
      expect(Date.now() - t).toBeLessThan(1500);
      expect(a.logs.filter((l) => l.event === "security.redis_unavailable")).toHaveLength(1);
      expect(a.logs.filter((l) => l.event === "security.redis_recovered")).toHaveLength(0);

      // the local fallback still protects this instance
      await a.detector.record("203.0.113.41", { type: "HONEYPOT" }, T0);
      await a.detector.record("203.0.113.41", { type: "HONEYPOT" }, T0 + 1);
      expect((await a.detector.check("203.0.113.41", false, T0 + 2)).action).toBe("block");
      expect(a.logs.filter((l) => l.event === "security.redis_unavailable")).toHaveLength(1); // not repeated

      // Redis comes back (empty): after the cooldown the shared store is used again
      await redis.start();
      let recovered = false;
      for (let i = 0; i < 40 && !recovered; i++) {
        await new Promise((r) => setTimeout(r, 100));
        await a.detector.record("203.0.113.42", { type: "HONEYPOT" }, T0);
        recovered = a.logs.some((l) => l.event === "security.redis_recovered");
      }
      expect(recovered).toBe(true);
      expect(a.logs.filter((l) => l.event === "security.redis_recovered")).toHaveLength(1);
      // shared again: what a records, b sees
      await b.detector.admit("203.0.113.43", false, T0).catch(() => undefined);
      await a.detector.record("203.0.113.44", { type: "HONEYPOT" }, T0);
      let seen = null;
      for (let i = 0; i < 40 && !seen; i++) {
        seen = await b.detector.inspect("203.0.113.44", T0);
        if (!seen) await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen?.level).toBe("THROTTLE");
    }, 30_000);

    it("a slow Redis does not slow requests beyond the timeout", async () => {
      const a = await instance(
        freshPrefix(),
        {},
        { timeoutMs: 100, failures: 2, cooldownMs: 5000 },
      );
      const admin = raw();
      await admin.client("PAUSE", 1500, "ALL"); // Redis stops answering for 1.5 s
      const t = Date.now();
      const decisions = [];
      for (let i = 0; i < 5; i++) decisions.push(await a.detector.admit(IP, false, T0 + i));
      expect(decisions.every((d) => d.action === "allow")).toBe(true);
      expect(Date.now() - t).toBeLessThan(1000); // two timeouts, then the breaker answers from memory
      expect(a.logs.filter((l) => l.event === "security.redis_unavailable")).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 1600));
    }, 20_000);
  });
});

describe("without REDIS_URL (single instance)", () => {
  const baseEnv = {
    JWT_SECRET: "x".repeat(40),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };

  it("keeps today's behaviour: the in-process memory store, no Redis involved", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.ABUSE_REDIS_PREFIX).toBe("tk:abuse:");
    const service = new AbuseService(config, new SystemClock(), {} as IpBlockStore);
    expect(service.store.kind).toBe("memory");
    expect(service.detector.store).toBe(service.store);
    // an empty value (as in .env.example) also means "no Redis"
    expect(loadConfig({ ...baseEnv, REDIS_URL: "" }).REDIS_URL).toBeUndefined();
    expect(() => loadConfig({ ...baseEnv, REDIS_URL: "localhost:6379" })).toThrow(/redis/u);
  });

  it("the memory store gives the same decisions as before (default options)", async () => {
    const events: Escalation[] = [];
    const detector = new AbuseDetector({}, (e) => events.push(e));
    await detector.record(IP, { type: "HONEYPOT" }, T0);
    await detector.record(IP, { type: "HONEYPOT" }, T0 + 1000);
    expect(events.map((e) => e.type)).toEqual(["THROTTLE", "BAN"]);
    expect(detector.tracked).toBe(1);
    expect(DEFAULT_OPTIONS.banScore).toBe(100);
  });
});
