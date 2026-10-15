import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { PlatformGuard } from "../../src/platform/platform.guard";
import { PlatformTenantsController } from "../../src/platform/platform-tenants.controller";
import { PlatformAuthService } from "../../src/platform/platform-auth.service";
import { totpCode } from "../../src/auth/totp";
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

const meta = { ip: null, userAgent: "test" };
const NEW_PASSWORD = "Another-strong passphrase 42";

/** Super Admin PRD 4: platform sign-in (password + mandatory authenticator) and organization management. */
describe.skipIf(!hasDb)("Super Admin: platform sign-in and tenants", () => {
  let h: Harness;
  let counter = 0;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (path: string, body: unknown, token?: string) => {
    const r = h.http().post(`/v1/platform/${path}`);
    return (token ? r.set(bearer(token)) : r).send(body as object);
  };
  const get = (path: string, token: string) =>
    h.http().get(`/v1/platform/${path}`).set(bearer(token));

  /** Creates a Super Admin through the console tool and walks the first sign-in (password change, authenticator). */
  async function superAdmin() {
    counter += 1;
    const username = `onki${Date.now().toString(36)}${counter}`;
    const created = await h.app
      .get(PlatformAuthService)
      .createOrReset({ username, displayName: "Onki" }, false, meta);
    const first = await post("auth/login", { username, password: created.temporaryPassword });
    expect(first.body.status).toBe("OK");
    expect(first.body.tokens.requires).toEqual(["PASSWORD_CHANGE", "TOTP_SETUP"]);
    const changed = await post(
      "auth/password/change",
      { currentPassword: created.temporaryPassword, newPassword: NEW_PASSWORD },
      first.body.tokens.accessToken,
    );
    expect(changed.status).toBe(200);
    expect(changed.body.requires).toEqual(["TOTP_SETUP"]);
    const setup = await post("auth/totp/setup", {}, changed.body.accessToken);
    h.clock.advanceSeconds(30);
    const enabled = await post(
      "auth/totp/enable",
      { code: totpCode(setup.body.secret, h.clock.now().getTime()) },
      changed.body.accessToken,
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.requires).toEqual([]);
    return {
      username,
      secret: setup.body.secret as string,
      token: enabled.body.accessToken as string,
    };
  }

  async function signInAgain(a: { username: string; secret: string }) {
    const first = await post("auth/login", { username: a.username, password: NEW_PASSWORD });
    expect(first.body.status).toBe("MFA_REQUIRED");
    h.clock.advanceSeconds(30);
    const second = await post("auth/totp/verify", {
      challengeToken: first.body.challengeToken,
      code: totpCode(a.secret, h.clock.now().getTime()),
    });
    expect(second.status).toBe(200);
    return second.body.accessToken as string;
  }

  it("first sign-in forces a new password and an authenticator; later sign-ins ask for the code", async () => {
    const a = await superAdmin();
    expect((await get("auth/me", a.token)).body.totpEnabled).toBe(true);
    const again = await signInAgain(a);
    expect((await get("tenants", again)).status).toBe(200);
  });

  it("a setup-pending session can reach nothing but its own account routes", async () => {
    counter += 1;
    const username = `pending${Date.now().toString(36)}${counter}`;
    const c = await h.app
      .get(PlatformAuthService)
      .createOrReset({ username, displayName: null }, false, meta);
    const first = await post("auth/login", { username, password: c.temporaryPassword });
    const res = await get("tenants", first.body.tokens.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SETUP_REQUIRED");
  });

  it("tenant tokens do not open platform routes and platform tokens do not open tenant routes", async () => {
    const a = await superAdmin();
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const tokens = await signIn(h, admin);
    expect((await get("tenants", tokens.accessToken)).status).toBe(401);
    expect((await h.http().get("/v1/auth/me").set(bearer(a.token))).status).toBe(401);
    expect((await h.http().get("/v1/users").set(bearer(a.token))).status).toBe(401);
    expect((await h.http().get("/v1/platform/tenants")).status).toBe(401);
  });

  it("every organization route is behind the platform guard", () => {
    const proto = PlatformTenantsController.prototype as unknown as Record<string, unknown>;
    const classGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      PlatformTenantsController,
    ) as unknown[];
    expect(classGuards).toContain(PlatformGuard);
    expect(
      Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("wrong passwords lock the account like any other", async () => {
    const a = await superAdmin();
    for (let i = 0; i < 5; i += 1)
      await post("auth/login", { username: a.username, password: "wrong-password-xyz" });
    const locked = await post("auth/login", { username: a.username, password: NEW_PASSWORD });
    expect(locked.status).toBe(423);
  });

  it("creates an organization with defaults and a first Organization Admin who can sign in", async () => {
    const a = await superAdmin();
    const code = `new${Date.now().toString(36)}`;
    const res = await post(
      "tenants",
      { code, name: "New Org", adminUsername: "boss.one", adminDisplayName: "Boss One" },
      a.token,
    );
    expect(res.status).toBe(201);
    expect(res.body.admin.temporaryPassword).toHaveLength(16);
    const id = res.body.tenant.id as string;

    const counts = await h.owner.query<{
      reasons: number;
      days: number;
      settings: number;
      consent: number;
      rules: number;
    }>(
      `SELECT (SELECT count(*)::int FROM absence_reason WHERE tenant_id = $1) AS reasons,
              (SELECT count(*)::int FROM working_week_day WHERE tenant_id = $1) AS days,
              (SELECT count(*)::int FROM tenant_setting WHERE tenant_id = $1) AS settings,
              (SELECT count(*)::int FROM consent_text_version WHERE tenant_id = $1 AND is_draft AND active) AS consent,
              (SELECT count(*)::int FROM attendance_rule_version WHERE tenant_id = $1) AS rules`,
      [id],
    );
    expect(counts.rows[0]).toEqual({ reasons: 16, days: 7, settings: 3, consent: 1, rules: 1 });

    const signed = await login(h, {
      orgCode: code,
      username: "boss.one",
      password: res.body.admin.temporaryPassword,
    });
    expect(signed.status).toBe(200);
    expect(signed.body.tokens.requires).toEqual(["PASSWORD_CHANGE", "TOTP_SETUP"]);

    const audit = await h.owner.query<{ action: string; actor_role: string }>(
      "SELECT action, actor_role FROM audit_log WHERE tenant_id = $1 ORDER BY id",
      [id],
    );
    expect(audit.rows.slice(0, 2)).toEqual([
      { action: "tenant.created", actor_role: "SUPER_ADMIN" },
      { action: "user.created", actor_role: "SUPER_ADMIN" },
    ]);

    // the list shows counts only
    const list = await get("tenants", a.token);
    const row = (list.body as Array<{ id: string; staffAccounts: number; employees: number }>).find(
      (t) => t.id === id,
    );
    expect(row).toMatchObject({ employees: 0, staffAccounts: 1 });
  });

  it("refuses a duplicate or reserved code, a bad time zone and a bad username", async () => {
    const a = await superAdmin();
    const base = { name: "X", adminUsername: "owner1", adminDisplayName: "Owner" };
    const code = `dup${Date.now().toString(36)}`;
    expect((await post("tenants", { ...base, code }, a.token)).status).toBe(201);
    const dup = await post("tenants", { ...base, code }, a.token);
    expect([dup.status, dup.body.code]).toEqual([409, "CODE_TAKEN"]);
    expect((await post("tenants", { ...base, code: "platform" }, a.token)).body.code).toBe(
      "CODE_RESERVED",
    );
    expect(
      (await post("tenants", { ...base, code: `tz${code}`, timeZone: "Mars/Base" }, a.token)).body
        .code,
    ).toBe("INVALID_TIME_ZONE");
    expect(
      (await post("tenants", { ...base, code: `u${code}`, adminUsername: "a b" }, a.token)).status,
    ).toBe(400);
    // nothing was left behind by the refused attempts
    const left = await h.owner.query("SELECT 1 FROM tenant WHERE code IN ($1, $2)", [
      `tz${code}`,
      `u${code}`,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("suspending stops sign-in and live sessions at once; activating brings them back", async () => {
    const a = await superAdmin();
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    const tokens = await signIn(h, admin);
    expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(200);

    const off = await post(`tenants/${tenant.id}/suspend`, {}, a.token);
    expect(off.body.status).toBe("SUSPENDED");
    expect((await post(`tenants/${tenant.id}/suspend`, {}, a.token)).status).toBe(409);
    expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401);
    expect(
      (await h.http().post("/v1/auth/refresh").send({ refreshToken: tokens.refreshToken })).status,
    ).toBe(401);
    expect((await login(h, admin)).status).toBe(401);

    expect((await post(`tenants/${tenant.id}/activate`, {}, a.token)).body.status).toBe("ACTIVE");
    expect((await login(h, admin)).status).toBe(200);
    const actions = await h.owner.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'tenant.%' ORDER BY id",
      [tenant.id],
    );
    expect(actions.rows.map((r) => r.action)).toEqual(["tenant.suspended", "tenant.activated"]);
  });

  it("renames, adds an Organization Admin and resets one (audited as the Super Admin)", async () => {
    const a = await superAdmin();
    const tenant = await createTenant(h);
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    await createUser(h, tenant, { username: "hr1", role: "HR" });

    expect(
      (
        await h
          .http()
          .patch(`/v1/platform/tenants/${tenant.id}`)
          .set(bearer(a.token))
          .send({ name: "Renamed" })
      ).body.name,
    ).toBe("Renamed");

    const added = await post(
      `tenants/${tenant.id}/admins`,
      { username: "second", displayName: "Second" },
      a.token,
    );
    expect(added.status).toBe(201);
    expect(added.body.temporaryPassword).toHaveLength(16);
    expect(
      (
        await post(
          `tenants/${tenant.id}/admins`,
          { username: "second", displayName: "Second" },
          a.token,
        )
      ).status,
    ).toBe(409);

    const reset = await post(
      `tenants/${tenant.id}/admins/reset`,
      { username: "admin", totp: true },
      a.token,
    );
    expect(reset.status).toBe(200);
    expect(reset.body.totpRemoved).toBe(true);
    const signed = await login(h, {
      orgCode: tenant.code,
      username: "admin",
      password: reset.body.temporaryPassword,
    });
    expect(signed.body.tokens.requires).toEqual(["PASSWORD_CHANGE", "TOTP_SETUP"]);
    expect((await login(h, admin)).status).toBe(401); // the old password is gone

    // only Organization Admins can be reset from here
    expect(
      (await post(`tenants/${tenant.id}/admins/reset`, { username: "hr1" }, a.token)).status,
    ).toBe(404);

    const detail = await get(`tenants/${tenant.id}`, a.token);
    expect(detail.body.admins.map((x: { username: string }) => x.username).sort()).toEqual([
      "admin",
      "second",
    ]);
    const roles = await h.owner.query<{ actor_role: string }>(
      "SELECT actor_role FROM audit_log WHERE tenant_id = $1 AND action IN ('user.password_reset','user.totp_reset','user.created')",
      [tenant.id],
    );
    expect(new Set(roles.rows.map((r) => r.actor_role))).toEqual(new Set(["SUPER_ADMIN"]));
  });

  it("logging out ends the session, and the activity list shows the trail", async () => {
    const a = await superAdmin();
    const activity = await get("activity", a.token);
    expect(activity.body.map((r: { action: string }) => r.action)).toContain(
      "platform.totp_enabled",
    );
    expect((await post("auth/logout", {}, a.token)).status).toBe(204);
    expect((await get("tenants", a.token)).status).toBe(401);
  });

  it("an unknown organization id is a 404 and a malformed one a 400", async () => {
    const a = await superAdmin();
    expect((await get("tenants/00000000-0000-4000-8000-000000000000", a.token)).status).toBe(404);
    expect((await get("tenants/not-a-uuid", a.token)).status).toBe(400);
  });
});
