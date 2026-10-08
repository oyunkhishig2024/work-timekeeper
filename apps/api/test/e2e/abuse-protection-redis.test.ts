import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { hasRedis, startRedis, type TestRedis } from "../redis-server";
import type { ResilientStateStore } from "../../src/security/abuse-redis";
import { AbuseService } from "../../src/security/abuse.service";
import { IpBlockStore } from "../../src/security/ip-block.store";
import { bearer, createTenant, createUser, type Harness, signIn, startHarness } from "./harness";

/**
 * Two API instances (two Nest applications, one database, one Redis): what one judges, the other enforces.
 * Needs PostgreSQL (TEST_DATABASE_URL) and a redis-server binary; skipped otherwise.
 */
describe.skipIf(!hasDb || !hasRedis)("abuse protection with several API instances (Redis)", () => {
  let redis: TestRedis;
  let a: Harness;
  let b: Harness;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    redis = await startRedis();
    for (const key of ["ABUSE_PROTECTION", "REDIS_URL", "ABUSE_REDIS_PREFIX"])
      saved[key] = process.env[key];
    process.env.ABUSE_PROTECTION = "on";
    process.env.REDIS_URL = redis.url;
    process.env.ABUSE_REDIS_PREFIX = `e2e${Date.now()}:abuse:`;
    for (const key of ["ABUSE_REDIS_TIMEOUT_MS", "ABUSE_REDIS_BREAKER_COOLDOWN_SECONDS"])
      saved[key] = process.env[key];
    process.env.ABUSE_REDIS_TIMEOUT_MS = "200";
    process.env.ABUSE_REDIS_BREAKER_COOLDOWN_SECONDS = "0.5";
    a = await startHarness({ trustProxy: "loopback" });
    b = await startHarness({ trustProxy: "loopback" });
  });
  afterAll(async () => {
    await b?.close();
    await a?.close();
    await redis?.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let counter = 100;
  const freshIp = () => `203.0.113.${counter++}`;
  const get = (h: Harness, ip: string, url: string, headers: Record<string, string> = {}) =>
    h
      .http()
      .get(url)
      .set({ "X-Forwarded-For": ip, ...headers });
  /** The record of a finished request is written just after its response: wait until it is visible. */
  const untilStatus = async (h: Harness, ip: string, status: number) => {
    const started = Date.now();
    let last = 0;
    while (Date.now() - started < 3000) {
      last = (await get(h, ip, "/v1/health")).status;
      if (last === status) return last;
      await new Promise((r) => setTimeout(r, 20));
    }
    return last;
  };

  it("both instances really use Redis", () => {
    expect(a.app.get(AbuseService).store.kind).toBe("redis");
    expect(b.app.get(AbuseService).store.kind).toBe("redis");
  });

  it("a ban decided by instance A is enforced by instance B at once, without waiting for the 30 s database sync", async () => {
    const ip = freshIp();
    expect((await get(b, ip, "/v1/health")).status).toBe(200);
    expect((await get(a, ip, "/.env")).status).toBe(404);
    expect((await get(b, ip, "/wp-login.php")).status).toBe(404); // the second probe lands on the OTHER instance
    expect(await untilStatus(a, ip, 429)).toBe(429);
    const refused = await get(b, ip, "/v1/health");
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("IP_TEMPORARILY_BLOCKED");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(800);
    // other addresses are unaffected on both
    expect((await get(a, freshIp(), "/v1/health")).status).toBe(200);
    expect((await get(b, freshIp(), "/v1/health")).status).toBe(200);
  });

  it("signed-in people behind a banned address keep working on every instance", async () => {
    const tenant = await createTenant(a);
    const admin = await signIn(
      a,
      await createUser(a, tenant, { username: "admin", role: "ORG_ADMIN", totp: true }),
    );
    const ip = freshIp();
    await get(a, ip, "/.env");
    await get(a, ip, "/.git/config");
    expect(await untilStatus(b, ip, 429)).toBe(429);
    expect((await get(b, ip, "/v1/departments", bearer(admin.accessToken))).status).toBe(200);
    expect((await get(a, ip, "/v1/departments", bearer(admin.accessToken))).status).toBe(200);
  });

  it("an operator lift clears the shared state: the other instance allows the address again immediately", async () => {
    const ip = freshIp();
    await get(a, ip, "/.env");
    await get(a, ip, "/phpmyadmin/");
    expect(await untilStatus(b, ip, 429)).toBe(429);
    await new Promise((r) => setTimeout(r, 150)); // the database row is written in the background

    const store = a.app.get(IpBlockStore);
    expect(await store.lift(ip, "ops", a.clock.now())).toBe(1);
    // instance A persisted the ban; its next sync lifts it in the shared state; B does nothing
    await a.app.get(AbuseService).sync();
    expect((await get(b, ip, "/v1/health")).status).toBe(200);
    expect((await get(a, ip, "/v1/health")).status).toBe(200);
  });

  it("a block added by an operator is loaded into the shared state by one instance and enforced by both, and its lift is noticed", async () => {
    const ip = freshIp();
    await a.app.get(IpBlockStore).manualBlock(ip, 30, "reported", a.clock.now());
    await b.app.get(AbuseService).sync(); // B loads it into the shared state...
    expect((await get(a, ip, "/v1/health")).status).toBe(429); // ...and A enforces it without having synced
    await a.app.get(AbuseService).sync(); // (every instance syncs every 30 s)
    expect((await get(a, ip, "/v1/health")).status).toBe(429);
    expect((await get(b, ip, "/v1/health")).status).toBe(429);
    // lifting a hand-made block is noticed too (it was listed at the previous sync)
    await a.app.get(IpBlockStore).lift(ip, "ops", a.clock.now());
    await a.app.get(AbuseService).sync();
    expect((await get(b, ip, "/v1/health")).status).toBe(200);
  });

  it("requests keep being served when Redis dies, and the shared judgement resumes after it returns", async () => {
    const ip = freshIp();
    await redis.kill();
    // every request is answered (fail open); first calls may take up to the command timeout
    for (let i = 0; i < 5; i++) expect((await get(a, ip, "/v1/health")).status).toBe(200);
    expect((await get(b, freshIp(), "/v1/health")).status).toBe(200);
    const degraded = (h: Harness) =>
      (h.app.get(AbuseService).store as ResilientStateStore).degraded;
    expect(degraded(a)).toBe(true); // the circuit breaker is open: logged once as security.redis_unavailable
    // each instance still protects itself from its own memory
    const local = freshIp();
    await get(a, local, "/.env");
    await get(a, local, "/.git/HEAD");
    expect(await untilStatus(a, local, 429)).toBe(429);

    await redis.start();
    // Redis is back (empty). After the cooldown one request probes it and the instance returns to the shared state.
    const started = Date.now();
    while ((degraded(a) || degraded(b)) && Date.now() - started < 15_000) {
      await get(a, freshIp(), "/v1/health");
      await get(b, freshIp(), "/v1/health");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(degraded(a) || degraded(b)).toBe(false);
    // shared again: one probe on each instance is enough for a ban that neither would decide alone
    const shared = freshIp();
    await get(a, shared, "/.env");
    await get(b, shared, "/.git/HEAD");
    expect(await untilStatus(a, shared, 429)).toBe(429);
    expect((await get(b, shared, "/v1/health")).status).toBe(429);
  }, 60_000);
});
