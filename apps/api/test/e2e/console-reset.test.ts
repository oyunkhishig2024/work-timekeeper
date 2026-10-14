import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsersService } from "../../src/users/users.service";
import { hasDb } from "../db/helpers";
import {
  bearer,
  createTenant,
  createUser,
  login,
  signIn,
  startHarness,
  type Harness,
} from "./harness";

const meta = { ip: null, userAgent: "cli" };

describe.skipIf(!hasDb)("password recovery from the server console", () => {
  let h: Harness;
  let users: UsersService;
  beforeAll(async () => {
    h = await startHarness();
    users = h.app.get(UsersService);
  });
  afterAll(async () => {
    await h.close();
  });

  it("gives the only Organization Admin a new one-time password, ends sessions and clears the lock", async () => {
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const tokens = await signIn(h, admin);
    // five wrong passwords lock the account
    for (let i = 0; i < 5; i += 1) await login(h, admin, "wrong-password-xyz");
    expect((await login(h, admin)).status).toBe(423);

    const result = await users.resetFromConsole(tenant.id, "ADMIN", { totp: false }, meta);
    expect(result.role).toBe("ORG_ADMIN");
    expect(result.totpRemoved).toBe(false);
    expect(result.activeOrgAdmins).toBe(1); // the caller prints a warning for this

    expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401);
    expect((await login(h, admin)).status).toBe(401); // the old password is gone
    const fresh = await login(h, { ...admin, password: result.temporaryPassword });
    expect(fresh.status).toBe(200);
    const { rows } = await h.owner.query(
      "SELECT must_change_password, totp_enabled, locked_until FROM user_account WHERE id = $1",
      [admin.id],
    );
    expect(rows[0]).toMatchObject({
      must_change_password: true,
      totp_enabled: true,
      locked_until: null,
    });
    const audit = await h.owner.query(
      "SELECT action, actor_role, actor_user_id FROM audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'",
      [tenant.id],
    );
    expect(audit.rows).toEqual([
      { action: "user.password_reset", actor_role: "system:cli", actor_user_id: null },
    ]);
  });

  it("also removes the authenticator and its recovery codes when asked", async () => {
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "boss", role: "ORG_ADMIN", totp: true });
    await createUser(h, tenant, { username: "boss2", role: "ORG_ADMIN" });
    await h.owner.query(
      "INSERT INTO user_recovery_code (tenant_id, user_id, code_hash) VALUES ($1, $2, 'x1'), ($1, $2, 'x2')",
      [tenant.id, admin.id],
    );
    const result = await users.resetFromConsole(tenant.id, "boss", { totp: true }, meta);
    expect(result.totpRemoved).toBe(true);
    expect(result.activeOrgAdmins).toBe(2);
    const { rows } = await h.owner.query(
      "SELECT totp_enabled, totp_secret_enc FROM user_account WHERE id = $1",
      [admin.id],
    );
    expect(rows[0]).toEqual({ totp_enabled: false, totp_secret_enc: null });
    const codes = await h.owner.query("SELECT 1 FROM user_recovery_code WHERE user_id = $1", [
      admin.id,
    ]);
    expect(codes.rowCount).toBe(0);
    const audit = await h.owner.query(
      "SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id",
      [tenant.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["user.password_reset", "user.totp_reset"]);
  });

  it("refuses an unknown user and a disabled account", async () => {
    const tenant = await createTenant(h);
    const user = await createUser(h, tenant, { username: "gone", role: "HR" });
    await expect(
      users.resetFromConsole(tenant.id, "nobody", { totp: false }, meta),
    ).rejects.toMatchObject({
      status: 404,
    });
    await h.owner.query("UPDATE user_account SET status = 'DISABLED' WHERE id = $1", [user.id]);
    await expect(
      users.resetFromConsole(tenant.id, "gone", { totp: false }, meta),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it("does not reach another organization's users", async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    await createUser(h, b, { username: "same-name", role: "HR" });
    await expect(
      users.resetFromConsole(a.id, "same-name", { totp: false }, meta),
    ).rejects.toMatchObject({ status: 404 });
  });
});
