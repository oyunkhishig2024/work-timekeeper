import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createEmployeeWithUser,
  createTenant,
  createUser,
  login,
  signIn,
  startHarness,
  type Harness,
} from "./harness";

describe.skipIf(!hasDb)("disabling and enabling HR and Manager accounts", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("a disabled account cannot sign in, its sessions end, and enabling brings it back", async () => {
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const mgr = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const adminTokens = await signIn(h, admin);
    const mgrTokens = await signIn(h, mgr);

    const off = await h
      .http()
      .post(`/v1/users/${mgr.id}/disable`)
      .set(bearer(adminTokens.accessToken));
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ id: mgr.id, status: "DISABLED" });
    expect((await h.http().get("/v1/auth/me").set(bearer(mgrTokens.accessToken))).status).toBe(401);
    expect((await login(h, mgr)).status).toBe(401);

    const list = await h.http().get("/v1/users").set(bearer(adminTokens.accessToken));
    expect(list.body.find((u: { id: string }) => u.id === mgr.id).status).toBe("DISABLED");

    const on = await h
      .http()
      .post(`/v1/users/${mgr.id}/enable`)
      .set(bearer(adminTokens.accessToken));
    expect(on.status).toBe(200);
    expect((await login(h, mgr)).status).toBe(200);
    const actions = await auditActions(h, tenant.id);
    expect(actions).toContain("user.disabled");
    expect(actions).toContain("user.enabled");
  });

  it("refuses yourself, another Organization Admin, an employee login and a caller who is not an Org Admin", async () => {
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const other = await createUser(h, tenant, {
      username: "admin2",
      role: "ORG_ADMIN",
      totp: true,
    });
    const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
    const { user: employee } = await createEmployeeWithUser(h, tenant, "emp");
    const adminTokens = await signIn(h, admin);
    const hrTokens = await signIn(h, hr);
    const post = (token: string, id: string) =>
      h.http().post(`/v1/users/${id}/disable`).set(bearer(token));

    expect((await post(adminTokens.accessToken, admin.id)).status).toBe(403);
    expect((await post(adminTokens.accessToken, other.id)).status).toBe(403);
    expect((await post(hrTokens.accessToken, admin.id)).status).toBe(403);
    expect((await post(adminTokens.accessToken, employee.id)).status).toBe(409);
    expect(
      (await post(adminTokens.accessToken, "00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
  });
});
