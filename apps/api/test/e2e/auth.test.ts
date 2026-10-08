import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../../src/auth/totp";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createTenant,
  createUser,
  type Harness,
  login,
  signIn,
  startHarness,
  type TokenBody,
} from "./harness";

describe.skipIf(!hasDb)("authentication (PRD 15.2)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  describe("password login", () => {
    it("gives the same answer for an unknown organization, unknown user and wrong password", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });

      const unknownOrg = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: "nope", username: "mgr", password: "x" });
      const unknownUser = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: tenant.code, username: "ghost", password: "x" });
      const wrongPassword = await login(h, user, "wrong password");

      for (const res of [unknownOrg, unknownUser, wrongPassword]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("INVALID_CREDENTIALS");
        expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      }
    });

    it("signs in a manager (no two-step login required) and returns the profile", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "Mgr", role: "MANAGER" });

      const res = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: tenant.code.toUpperCase(), username: "mgr", password: user.password });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("OK");
      const tokens = res.body.tokens as TokenBody;
      expect(tokens.requires).toEqual([]);
      expect(tokens.expiresIn).toBe(900);

      const me = await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        username: "Mgr",
        role: "MANAGER",
        totpEnabled: false,
        requires: [],
      });
      // The dashboard needs the organization's name and its own "today" (tenant time zone, PRD 22.2).
      expect(me.body.organization).toMatchObject({ timeZone: "Asia/Ulaanbaatar" });
      expect(me.body.organization.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(me.body.organization.name).toBeTruthy();
    });

    it("rejects disabled accounts like unknown ones", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "gone", role: "MANAGER" });
      await h.owner.query("UPDATE user_account SET status = 'DISABLED' WHERE id = $1", [user.id]);
      const res = await login(h, user);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_CREDENTIALS");
    });

    it("locks the account after 5 failures, even for the right password, until the lock expires", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "locky", role: "MANAGER" });

      for (let i = 1; i <= 4; i += 1) {
        expect((await login(h, user, "wrong")).status).toBe(401);
      }
      const fifth = await login(h, user, "wrong");
      expect(fifth.status).toBe(423);
      expect(fifth.body.code).toBe("ACCOUNT_LOCKED");
      expect(fifth.body.retryAfterSeconds).toBe(900);

      const whileLocked = await login(h, user);
      expect(whileLocked.status).toBe(423);

      h.clock.advanceSeconds(15 * 60 + 1);
      const after = await login(h, user);
      expect(after.status).toBe(200);

      const actions = await auditActions(h, tenant.id);
      expect(actions).toContain("auth.account_locked");
      expect(actions.filter((a) => a === "auth.login_failed")).toHaveLength(4);
    });

    it("a successful login resets the failure counter", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "resetter", role: "MANAGER" });
      for (let i = 0; i < 4; i += 1) await login(h, user, "wrong");
      expect((await login(h, user)).status).toBe(200);
      for (let i = 0; i < 4; i += 1) expect((await login(h, user, "wrong")).status).toBe(401);
    });
  });

  describe("access control", () => {
    it("requires a valid bearer token", async () => {
      expect((await h.http().get("/v1/auth/me")).status).toBe(401);
      expect((await h.http().get("/v1/auth/me").set(bearer("garbage"))).status).toBe(401);
      expect((await h.http().get("/v1/health")).status).toBe(200);
    });

    it("rejects a token as soon as its session is revoked or the user is disabled (PRD 12.2)", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "m1", role: "MANAGER" });
      const tokens = await signIn(h, user);
      expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(200);

      await h.owner.query("UPDATE user_account SET status = 'DISABLED' WHERE id = $1", [user.id]);
      expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401);
    });

    it("logout revokes the session", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "m2", role: "MANAGER" });
      const tokens = await signIn(h, user);
      expect((await h.http().post("/v1/auth/logout").set(bearer(tokens.accessToken))).status).toBe(
        204,
      );
      expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401);
      expect(
        (await h.http().post("/v1/auth/refresh").send({ refreshToken: tokens.refreshToken }))
          .status,
      ).toBe(401);
    });

    it("access tokens expire after 15 minutes", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "m3", role: "MANAGER" });
      const tokens = await signIn(h, user);
      h.clock.advanceSeconds(16 * 60);
      expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401);
    });
  });

  describe("refresh tokens", () => {
    it("rotates on every use and revokes the whole family when an old token is replayed", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "m4", role: "MANAGER" });
      const first = await signIn(h, user);

      const second = (
        await h.http().post("/v1/auth/refresh").send({ refreshToken: first.refreshToken })
      ).body as TokenBody;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect((await h.http().get("/v1/auth/me").set(bearer(second.accessToken))).status).toBe(200);

      // Replaying the first (already used) token is theft: everything in the family is revoked.
      const replay = await h
        .http()
        .post("/v1/auth/refresh")
        .send({ refreshToken: first.refreshToken });
      expect(replay.status).toBe(401);
      expect(
        (await h.http().post("/v1/auth/refresh").send({ refreshToken: second.refreshToken }))
          .status,
      ).toBe(401);
      expect((await h.http().get("/v1/auth/me").set(bearer(second.accessToken))).status).toBe(401);
      expect(await auditActions(h, tenant.id)).toContain("auth.refresh_token_reuse_detected");
    });

    it("staff sessions expire after 30 minutes idle; each refresh extends them", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "m5", role: "MANAGER" });
      let tokens = await signIn(h, user);
      for (let i = 0; i < 3; i += 1) {
        h.clock.advanceSeconds(20 * 60);
        const res = await h
          .http()
          .post("/v1/auth/refresh")
          .send({ refreshToken: tokens.refreshToken });
        expect(res.status).toBe(200);
        tokens = res.body as TokenBody;
      }
      h.clock.advanceSeconds(31 * 60);
      expect(
        (await h.http().post("/v1/auth/refresh").send({ refreshToken: tokens.refreshToken }))
          .status,
      ).toBe(401);
    });

    it("rejects malformed refresh tokens", async () => {
      expect(
        (await h.http().post("/v1/auth/refresh").send({ refreshToken: "nonsense" })).status,
      ).toBe(401);
      expect((await h.http().post("/v1/auth/refresh").send({})).status).toBe(400);
    });
  });

  describe("first login: forced password change (PRD 15.2)", () => {
    it("blocks everything else until the password is changed, then ends old sessions", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, {
        username: "newbie",
        role: "MANAGER",
        mustChangePassword: true,
      });
      const tokens = await signIn(h, user);
      expect(tokens.requires).toEqual(["PASSWORD_CHANGE"]);

      const create = await h.http().post("/v1/users").set(bearer(tokens.accessToken)).send({});
      expect(create.status).toBe(403);
      expect(create.body.code).toBe("SETUP_REQUIRED");
      expect(create.body.required).toEqual(["PASSWORD_CHANGE"]);

      const change = (body: object) =>
        h.http().post("/v1/auth/password/change").set(bearer(tokens.accessToken)).send(body);
      expect(
        (await change({ currentPassword: "wrong", newPassword: "A fine new passphrase" })).status,
      ).toBe(401);
      expect(
        (await change({ currentPassword: user.password, newPassword: "short" })).body.code,
      ).toBe("WEAK_PASSWORD");
      expect(
        (await change({ currentPassword: user.password, newPassword: user.password })).body.code,
      ).toBe("WEAK_PASSWORD");

      const ok = await change({
        currentPassword: user.password,
        newPassword: "A fine new passphrase",
      });
      expect(ok.status).toBe(200);
      expect((ok.body as TokenBody).requires).toEqual([]);

      expect((await h.http().get("/v1/auth/me").set(bearer(tokens.accessToken))).status).toBe(401); // old session ended
      expect((await h.http().get("/v1/auth/me").set(bearer(ok.body.accessToken))).status).toBe(200);
      expect((await login(h, user)).status).toBe(401);
      expect((await login(h, user, "A fine new passphrase")).status).toBe(200);
      expect(await auditActions(h, tenant.id)).toContain("auth.password_changed");
    });
  });

  describe("two-step login with an authenticator app (TOTP)", () => {
    it("HR must enrol first, then every login needs a code; codes cannot be replayed", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "hr1", role: "HR" });

      const first = await signIn(h, user);
      expect(first.requires).toEqual(["TOTP_SETUP"]);
      expect(
        (await h.http().post("/v1/users").set(bearer(first.accessToken)).send({})).body.code,
      ).toBe("SETUP_REQUIRED");

      const setup = await h.http().post("/v1/auth/totp/setup").set(bearer(first.accessToken));
      expect(setup.status).toBe(200);
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Timekeeper%20Work%3Ahr1\?/);
      const secret = setup.body.secret as string;

      const wrong = await h
        .http()
        .post("/v1/auth/totp/enable")
        .set(bearer(first.accessToken))
        .send({ code: "000000" });
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe("INVALID_CODE");

      const code = totpCode(secret, h.clock.now().getTime());
      const enabled = await h
        .http()
        .post("/v1/auth/totp/enable")
        .set(bearer(first.accessToken))
        .send({ code });
      expect(enabled.status).toBe(200);
      const enabledBody = enabled.body as TokenBody;
      expect(enabledBody.requires).toEqual([]);
      expect(enabledBody.recoveryCodes).toHaveLength(8);
      expect(
        (await h.http().post("/v1/auth/totp/setup").set(bearer(enabledBody.accessToken))).body.code,
      ).toBe("TOTP_ALREADY_ENABLED");

      // The secret is stored encrypted, never in clear.
      const stored = await h.owner.query("SELECT totp_secret_enc FROM user_account WHERE id = $1", [
        user.id,
      ]);
      expect(stored.rows[0].totp_secret_enc).not.toContain(secret);

      // Next login: password alone is not enough.
      const step1 = await login(h, user);
      expect(step1.body.status).toBe("MFA_REQUIRED");
      expect(step1.body.tokens).toBeUndefined();
      const challenge = step1.body.challengeToken as string;

      // The code used at enrolment is already spent for this 30-second window (replay protection).
      const replay = await h
        .http()
        .post("/v1/auth/totp/verify")
        .send({ challengeToken: challenge, code });
      expect(replay.status).toBe(401);

      h.clock.advanceSeconds(30);
      const good = totpCode(secret, h.clock.now().getTime());
      const verified = await h
        .http()
        .post("/v1/auth/totp/verify")
        .send({ challengeToken: challenge, code: good });
      expect(verified.status).toBe(200);
      expect((verified.body as TokenBody).requires).toEqual([]);
      expect(
        (
          await h
            .http()
            .post("/v1/auth/totp/verify")
            .send({ challengeToken: challenge, code: good })
        ).status,
      ).toBe(401);

      expect(await auditActions(h, tenant.id)).toEqual(
        expect.arrayContaining([
          "auth.totp_setup_started",
          "auth.totp_enabled",
          "auth.login_success",
        ]),
      );
    });

    it("recovery codes work once", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "hr2", role: "HR" });
      const tokens = await signIn(h, user);
      const secret = (await h.http().post("/v1/auth/totp/setup").set(bearer(tokens.accessToken)))
        .body.secret as string;
      const enabled = (
        await h
          .http()
          .post("/v1/auth/totp/enable")
          .set(bearer(tokens.accessToken))
          .send({ code: totpCode(secret, h.clock.now().getTime()) })
      ).body as TokenBody;
      const [recovery] = enabled.recoveryCodes!;

      const challenge = (await login(h, user)).body.challengeToken as string;
      const used = await h
        .http()
        .post("/v1/auth/totp/verify")
        .send({ challengeToken: challenge, recoveryCode: recovery!.toLowerCase() });
      expect(used.status).toBe(200);

      const challenge2 = (await login(h, user)).body.challengeToken as string;
      expect(
        (
          await h
            .http()
            .post("/v1/auth/totp/verify")
            .send({ challengeToken: challenge2, recoveryCode: recovery })
        ).status,
      ).toBe(401);
      expect(await auditActions(h, tenant.id)).toContain("auth.recovery_code_used");
    });

    it("wrong codes count towards the lockout", async () => {
      const tenant = await createTenant(h);
      const user = await createUser(h, tenant, { username: "hr3", role: "HR", totp: true });
      const challenge = (await login(h, user)).body.challengeToken as string;
      for (let i = 0; i < 4; i += 1) {
        expect(
          (
            await h
              .http()
              .post("/v1/auth/totp/verify")
              .send({ challengeToken: challenge, code: "111111" })
          ).status,
        ).toBe(401);
      }
      const locked = await h
        .http()
        .post("/v1/auth/totp/verify")
        .send({ challengeToken: challenge, code: "111111" });
      expect(locked.status).toBe(423);
    });

    it("validates the request shape", async () => {
      const bad = await h.http().post("/v1/auth/totp/verify").send({ challengeToken: "x" });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("VALIDATION_ERROR");
      expect(
        (await h.http().post("/v1/auth/totp/verify").send({ challengeToken: "x", code: "1" }))
          .status,
      ).toBe(401);
    });
  });

  describe("user administration", () => {
    it("Org Admin creates HR/Manager users; others cannot; usernames are unique", async () => {
      const tenant = await createTenant(h);
      const admin = await createUser(h, tenant, {
        username: "admin",
        role: "ORG_ADMIN",
        totp: true,
      });
      const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
      const adminTokens = await signIn(h, admin);
      const hrTokens = await signIn(h, hr);

      expect((await h.http().post("/v1/users").send({})).status).toBe(401);
      expect(
        (
          await h
            .http()
            .post("/v1/users")
            .set(bearer(hrTokens.accessToken))
            .send({ username: "x1x", displayName: "X", role: "HR" })
        ).status,
      ).toBe(403);

      const created = await h
        .http()
        .post("/v1/users")
        .set(bearer(adminTokens.accessToken))
        .send({ username: "gantsooj", displayName: "Gantsooj", role: "MANAGER" });
      expect(created.status).toBe(201);
      expect(created.body.temporaryPassword).toHaveLength(16);
      expect(created.body.role).toBe("MANAGER");

      const dup = await h
        .http()
        .post("/v1/users")
        .set(bearer(adminTokens.accessToken))
        .send({ username: "GANTSOOJ", displayName: "G", role: "HR" });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("USERNAME_TAKEN");

      expect(
        (
          await h
            .http()
            .post("/v1/users")
            .set(bearer(adminTokens.accessToken))
            .send({ username: "evil", displayName: "E", role: "ORG_ADMIN" })
        ).status,
      ).toBe(400);

      // The new user can sign in only with the temporary password and must change it.
      const newUserLogin = await h.http().post("/v1/auth/login").send({
        orgCode: tenant.code,
        username: "gantsooj",
        password: created.body.temporaryPassword,
      });
      expect(newUserLogin.body.tokens.requires).toEqual(["PASSWORD_CHANGE"]);

      const actions = await auditActions(h, tenant.id);
      expect(actions).toContain("user.created");
      const stored = await h.owner.query(
        "SELECT password_hash FROM user_account WHERE username = 'gantsooj'",
      );
      expect(stored.rows[0].password_hash).not.toContain(created.body.temporaryPassword);
    });

    it("password reset ends the target's sessions and forces a change; roles are respected", async () => {
      const tenant = await createTenant(h);
      const admin = await createUser(h, tenant, {
        username: "admin",
        role: "ORG_ADMIN",
        totp: true,
      });
      const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
      const mgr = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
      const adminTokens = await signIn(h, admin);
      const hrTokens = await signIn(h, hr);
      const mgrTokens = await signIn(h, mgr);

      // HR may not reset managers or admins; nobody resets themselves here; managers manage nobody.
      expect(
        (
          await h
            .http()
            .post(`/v1/users/${mgr.id}/reset-password`)
            .set(bearer(hrTokens.accessToken))
        ).status,
      ).toBe(403);
      expect(
        (
          await h
            .http()
            .post(`/v1/users/${admin.id}/reset-password`)
            .set(bearer(hrTokens.accessToken))
        ).status,
      ).toBe(403);
      expect(
        (
          await h
            .http()
            .post(`/v1/users/${admin.id}/reset-password`)
            .set(bearer(adminTokens.accessToken))
        ).status,
      ).toBe(403);
      expect(
        (
          await h
            .http()
            .post(`/v1/users/${hr.id}/reset-password`)
            .set(bearer(mgrTokens.accessToken))
        ).status,
      ).toBe(403);

      const reset = await h
        .http()
        .post(`/v1/users/${mgr.id}/reset-password`)
        .set(bearer(adminTokens.accessToken));
      expect(reset.status).toBe(200);
      expect((await h.http().get("/v1/auth/me").set(bearer(mgrTokens.accessToken))).status).toBe(
        401,
      );
      expect((await login(h, mgr)).status).toBe(401);
      const relogin = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: tenant.code, username: "mgr", password: reset.body.temporaryPassword });
      expect(relogin.body.tokens.requires).toEqual(["PASSWORD_CHANGE"]);
      expect(
        (
          await h
            .http()
            .post(`/v1/users/not-a-uuid/reset-password`)
            .set(bearer(adminTokens.accessToken))
        ).status,
      ).toBe(400);
      expect(await auditActions(h, tenant.id)).toContain("user.password_reset");
    });

    it("authenticator reset (lost phone) forces re-enrolment", async () => {
      const tenant = await createTenant(h);
      const admin = await createUser(h, tenant, {
        username: "admin",
        role: "ORG_ADMIN",
        totp: true,
      });
      const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
      const adminTokens = await signIn(h, admin);

      expect(
        (await h.http().post(`/v1/users/${hr.id}/totp-reset`).set(bearer(adminTokens.accessToken)))
          .status,
      ).toBe(200);
      const next = await login(h, hr);
      expect(next.body.status).toBe("OK");
      expect(next.body.tokens.requires).toEqual(["TOTP_SETUP"]);
    });

    it("never exposes another tenant's users", async () => {
      const a = await createTenant(h);
      const b = await createTenant(h);
      const adminA = await createUser(h, a, { username: "admin", role: "ORG_ADMIN", totp: true });
      const victimB = await createUser(h, b, { username: "victim", role: "MANAGER" });
      const tokensA = await signIn(h, adminA);

      const res = await h
        .http()
        .post(`/v1/users/${victimB.id}/reset-password`)
        .set(bearer(tokensA.accessToken));
      expect(res.status).toBe(404);
      expect((await login(h, victimB)).status).toBe(200); // untouched
    });
  });
});
