import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  bearer,
  createEmployee,
  createTenant,
  createUser,
  login,
  signIn,
  startHarness,
  type Harness,
} from "./harness";

describe.skipIf(!hasDb)("the Boss role: sees everything, read-only, not tracked", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function world() {
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const boss = await createUser(h, tenant, { username: "boss", role: "BOSS", totp: true });
    const mgr = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
    const first = await createEmployee(h, tenant);
    const second = await createEmployee(h, tenant);
    return { tenant, admin, boss, mgr, hr, first, second };
  }

  it("reads the whole organization while a Manager with no scope reads nothing", async () => {
    const w = await world();
    const bossToken = (await signIn(h, w.boss)).accessToken;
    const mgrToken = (await signIn(h, w.mgr)).accessToken;
    const bossList = await h.http().get("/v1/employees").set(bearer(bossToken));
    expect(bossList.status).toBe(200);
    expect(bossList.body.total).toBe(2);
    expect((await h.http().get("/v1/employees").set(bearer(mgrToken))).body.total).toBe(0);
    const date = h.clock.now().toISOString().slice(0, 10);
    for (const path of [
      `/v1/attendance/daily?date=${date}`,
      `/v1/attendance/summary?date=${date}`,
      "/v1/departments",
    ]) {
      expect((await h.http().get(path).set(bearer(bossToken))).status, path).toBe(200);
    }
  });

  it("cannot change anything and cannot use the phone endpoints", async () => {
    const w = await world();
    const token = (await signIn(h, w.boss)).accessToken;
    const writes: Array<[string, string]> = [
      ["post", "/v1/employees"],
      ["post", "/v1/reason-assignments"],
      ["put", "/v1/working-week"],
      ["post", "/v1/users"],
      ["post", "/v1/attendance/corrections"],
    ];
    for (const [method, path] of writes) {
      const res = await h.http()[method as "post" | "put"](path).set(bearer(token)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await h.http().post("/v1/events").set(bearer(token)).send({ events: [] })).status).toBe(
      403,
    );
    expect((await h.http().get("/v1/devices/me").set(bearer(token))).status).toBe(403);
    expect((await h.http().get("/v1/me/attendance").set(bearer(token))).status).toBe(403);
  });

  it("needs two-step sign-in set up, like Org Admin and HR", async () => {
    const tenant = await createTenant(h);
    const boss = await createUser(h, tenant, { username: "boss", role: "BOSS" }); // no authenticator yet
    const first = await login(h, boss);
    expect(first.status).toBe(200);
    expect(first.body.tokens.requires).toContain("TOTP_SETUP");
  });

  it("Org Admin creates a Boss without an employee record and a Manager with one", async () => {
    const w = await world();
    const adminToken = (await signIn(h, w.admin)).accessToken;
    const post = (body: object) => h.http().post("/v1/users").set(bearer(adminToken)).send(body);

    const boss = await post({ username: "boss2", displayName: "Дарга", role: "BOSS" });
    expect(boss.status).toBe(201);
    expect(typeof boss.body.temporaryPassword).toBe("string");
    expect(
      (await post({ username: "boss3", displayName: "X", role: "BOSS", employeeId: w.first.id }))
        .status,
    ).toBe(400);

    expect((await post({ username: "mgr2", displayName: "M", role: "MANAGER" })).status).toBe(400);
    const mgr = await post({
      username: "mgr3",
      displayName: "M",
      role: "MANAGER",
      employeeId: w.first.id,
    });
    expect(mgr.status).toBe(201);
    const list = await h.http().get("/v1/users").set(bearer(adminToken));
    const row = list.body.find((u: { username: string }) => u.username === "mgr3");
    expect(row).toMatchObject({ role: "MANAGER", employeeId: w.first.id });
    // the same employee cannot be a second login
    expect(
      (await post({ username: "mgr4", displayName: "M", role: "MANAGER", employeeId: w.first.id }))
        .status,
    ).toBe(409);
    // a former employee cannot become a Manager
    await h.owner.query("UPDATE employee SET status = 'DISABLED' WHERE id = $1", [w.second.id]);
    expect(
      (await post({ username: "mgr5", displayName: "M", role: "MANAGER", employeeId: w.second.id }))
        .status,
    ).toBe(409);
  });

  it("Org Admin manages a Boss account; HR does not; a Boss has no scope or employee link", async () => {
    const w = await world();
    const adminToken = (await signIn(h, w.admin)).accessToken;
    const hrToken = (await signIn(h, w.hr)).accessToken;
    const reset = (token: string) =>
      h.http().post(`/v1/users/${w.boss.id}/reset-password`).set(bearer(token));
    expect((await reset(hrToken)).status).toBe(403);
    expect((await reset(adminToken)).status).toBe(200);
    expect(
      (await h.http().post(`/v1/users/${w.boss.id}/disable`).set(bearer(adminToken))).status,
    ).toBe(200);
    expect((await login(h, w.boss)).status).toBe(401);
    expect(
      (await h.http().post(`/v1/users/${w.boss.id}/enable`).set(bearer(adminToken))).status,
    ).toBe(200);
    const link = await h
      .http()
      .put(`/v1/users/${w.boss.id}/employee`)
      .set(bearer(adminToken))
      .send({ employeeId: w.first.id });
    expect(link.status).toBe(409);
    expect(link.body.code).toBe("BOSS_NOT_TRACKED");
    const scope = await h
      .http()
      .put(`/v1/users/${w.boss.id}/scope`)
      .set(bearer(adminToken))
      .send({ locationIds: [], departmentIds: [] });
    expect(scope.status).toBeGreaterThanOrEqual(400);
  });
});
