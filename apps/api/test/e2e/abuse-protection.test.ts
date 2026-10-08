import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { AbuseService } from "../../src/security/abuse.service";
import { IpBlockStore } from "../../src/security/ip-block.store";
import { bearer, createTenant, createUser, type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("adaptive abuse protection (throttle -> temporary ban)", () => {
  let h: Harness;
  beforeAll(async () => {
    process.env.ABUSE_PROTECTION = "on";
    h = await startHarness({ trustProxy: "loopback" });
  });
  afterAll(async () => {
    await h.close();
    process.env.ABUSE_PROTECTION = "off";
  });

  let counter = 10;
  /** A fresh client address per test so tests do not influence each other. */
  const freshIp = () => `203.0.113.${counter++}`;
  const from = (ip: string) => ({ "X-Forwarded-For": ip });
  const get = (ip: string, url: string, headers: Record<string, string> = {}) =>
    h
      .http()
      .get(url)
      .set({ ...from(ip), ...headers });
  const login = (ip: string, username: string, headers: Record<string, string> = {}) =>
    h
      .http()
      .post("/v1/auth/login")
      .set({ ...from(ip), ...headers })
      .send({ orgCode: "nope", username, password: "wrong-password" });

  it("normal traffic from an address is never touched", async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await get(ip, "/v1/health")).status).toBe(200);
  });

  it("probing known attack paths: the first probe throttles, the second bans; anonymous requests are then refused with Retry-After", async () => {
    const ip = freshIp();
    expect((await get(ip, "/.env")).status).toBe(404);
    expect((await get(ip, "/wp-login.php")).status).toBe(404);
    const refused = await get(ip, "/v1/health");
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("IP_TEMPORARILY_BLOCKED");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(800);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(900);
    expect(refused.headers["content-type"]).toContain("application/problem+json");
    // other addresses and the proxy itself are unaffected
    expect((await get(freshIp(), "/v1/health")).status).toBe(200);
    expect((await h.http().get("/v1/health")).status).toBe(200);
    // the ban is written down for the operator
    const rows = await h.owner.query(
      "SELECT strike, reason, signals, expires_at > now() AS active FROM ip_block WHERE ip = $1::inet",
      [ip],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ strike: 1, reason: "HONEYPOT", active: true });
    expect(rows.rows[0].signals).toMatchObject({ HONEYPOT: 2 });
  });

  it("a signed-in person behind a banned address (shared network) keeps working", async () => {
    const tenant = await createTenant(h);
    const admin = await signIn(
      h,
      await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true }),
    );
    const ip = freshIp();
    await get(ip, "/.env");
    await get(ip, "/.git/config");
    expect((await get(ip, "/v1/health")).status).toBe(429);
    const asEmployee = await get(ip, "/v1/departments", bearer(admin.accessToken));
    expect(asEmployee.status).toBe(200);
    // ...but the login endpoint is closed to that address, so nobody can brute-force from it
    expect((await login(ip, "someone")).status).toBe(429);
    // and a forged or garbage token does not count as signed in
    expect((await get(ip, "/v1/departments", { Authorization: "Bearer aaa.bbb.ccc" })).status).toBe(
      429,
    );
  });

  it("credential stuffing (many usernames) is throttled long before a single forgetful user would be", async () => {
    const stuffer = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await login(stuffer, `victim-${i}`)).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    // by now the address is throttled (20 anonymous requests a minute): the flood of attempts is refused soon
    const more: number[] = [];
    for (let i = 0; i < 40; i++) more.push((await login(stuffer, `victim-${i + 10}`)).status);
    expect(more).toContain(429);
    // one user mistyping a password a few times is left alone
    const forgetful = freshIp();
    for (let i = 0; i < 4; i++) expect((await login(forgetful, "bat")).status).toBe(401);
    expect((await get(forgetful, "/v1/health")).status).toBe(200);
  });

  it("an unauthenticated flood of unknown URLs (enumeration) escalates, a signed-in user's 404s do not", async () => {
    const scanner = freshIp();
    const results: number[] = [];
    for (let i = 0; i < 60; i++)
      results.push(
        (
          await get(
            scanner,
            `/v1/probe-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}-x`,
          )
        ).status,
      );
    expect(results).toContain(429);
    const tenant = await createTenant(h);
    const user = await signIn(
      h,
      await createUser(h, tenant, { username: "hr", role: "HR", totp: true }),
    );
    const colleague = freshIp();
    for (let i = 0; i < 60; i++) {
      const unknown = `/v1/missing-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}-x`;
      expect((await get(colleague, unknown, bearer(user.accessToken))).status).toBe(404);
    }
    expect((await get(colleague, "/v1/health")).status).toBe(200);
  });

  it("scanner user agents are recorded", async () => {
    const ip = freshIp();
    await get(ip, "/v1/health", { "User-Agent": "sqlmap/1.7" });
    const state = h.app.get(AbuseService).detector.inspect(ip, h.clock.now().getTime());
    expect(state?.score).toBeGreaterThan(20);
    expect((await get(freshIp(), "/v1/health", { "User-Agent": "Mozilla/5.0" })).status).toBe(200);
  });

  it("a ban survives a restart, can be lifted by an operator, and ends by itself", async () => {
    const abuse = h.app.get(AbuseService);
    const store = h.app.get(IpBlockStore);
    const ip = freshIp();
    await get(ip, "/.env");
    await get(ip, "/phpmyadmin/");
    expect((await get(ip, "/v1/health")).status).toBe(429);
    await new Promise((r) => setTimeout(r, 100)); // the row is written in the background

    // a second application instance (restart) picks the ban up from the database
    const second = await startHarness({ trustProxy: "loopback" });
    try {
      expect((await second.http().get("/v1/health").set(from(ip))).status).toBe(429);
    } finally {
      await second.close();
    }

    // the operator lifts it: it takes effect at the next sync
    expect(await store.lift(ip, "ops", h.clock.now())).toBe(1);
    await abuse.sync();
    expect((await get(ip, "/v1/health")).status).toBe(200);

    // an operator can also block by hand; it is picked up by the sync
    const manual = freshIp();
    await store.manualBlock(manual, 30, "reported by hosting provider", h.clock.now());
    await abuse.sync();
    expect((await get(manual, "/v1/health")).status).toBe(429);
    h.clock.advanceSeconds(31 * 60);
    await abuse.sync();
    expect((await get(manual, "/v1/health")).status).toBe(200);

    // a ban decided by the detector ends by itself
    const timed = freshIp();
    await get(timed, "/.env");
    await get(timed, "/.git/HEAD");
    expect((await get(timed, "/v1/health")).status).toBe(429);
    h.clock.advanceSeconds(16 * 60);
    expect((await get(timed, "/v1/health")).status).toBe(200);
  });

  it("a repeat offender gets a longer second ban (1 hour)", async () => {
    const ip = freshIp();
    await get(ip, "/.env");
    await get(ip, "/.git/config");
    h.clock.advanceSeconds(16 * 60);
    expect((await get(ip, "/v1/health")).status).toBe(200);
    await get(ip, "/wp-admin/");
    await get(ip, "/xmlrpc.php");
    const refused = await get(ip, "/v1/health");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(3500);
    await new Promise((r) => setTimeout(r, 100)); // the row is written in the background
    const rows = await h.owner.query(
      "SELECT strike FROM ip_block WHERE ip = $1::inet ORDER BY created_at",
      [ip],
    );
    expect(rows.rows.map((r) => r.strike)).toEqual([1, 2]);
  });

  it("lists the history of one address for the operator", async () => {
    const ip = freshIp();
    await get(ip, "/.env");
    await get(ip, "/server-status");
    await new Promise((r) => setTimeout(r, 100));
    const history = await h.app.get(IpBlockStore).history(ip, 10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ ip, strike: 1, liftedAt: null });
  });
});
