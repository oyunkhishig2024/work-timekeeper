import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** Auth review fixes: HR reset respects the data scope, one-time passwords expire, resets are announced. */
describe.skipIf(!hasDb)("password hygiene", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function world() {
    const tenant = await createTenant(h);
    const loc = await h.owner.query<{ id: string }>(
      "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Төв', 47.9, 106.9, 150) RETURNING id",
      [tenant.id],
    );
    const dept = async (name: string) =>
      (
        await h.owner.query<{ id: string }>(
          "INSERT INTO department (tenant_id, name) VALUES ($1, $2) RETURNING id",
          [tenant.id, name],
        )
      ).rows[0]!.id;
    const deptA = await dept("A");
    const deptB = await dept("B");
    let n = 0;
    const employeeIn = async (departmentId: string, username: string) => {
      n += 1;
      const e = await h.owner.query<{ id: string }>(
        `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenant.id, `S-${n}`, `Ажилтан ${n}`, departmentId, loc.rows[0]!.id],
      );
      return createUser(h, tenant, { username, role: "EMPLOYEE", employeeId: e.rows[0]!.id });
    };
    const inA = await employeeIn(deptA, "in.a");
    const inB = await employeeIn(deptB, "in.b");
    const hr = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
    const admin = await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true });
    return { tenant, deptA, inA, inB, hr, admin };
  }

  const reset = (token: string, userId: string) =>
    h.http().post(`/v1/users/${userId}/reset-password`).set(bearer(token)).send({});

  it("an HR user with a data scope cannot reset the password of an employee outside it", async () => {
    const w = await world();
    await h.owner.query(
      "INSERT INTO user_scope (tenant_id, user_id, department_id) VALUES ($1, $2, $3)",
      [w.tenant.id, w.hr.id, w.deptA],
    );
    const hr = await signIn(h, w.hr);
    const outside = await reset(hr.accessToken, w.inB.id);
    expect([outside.status, outside.body.code]).toEqual([404, "USER_NOT_FOUND"]);
    // the employee outside the scope still signs in with the old password
    expect((await login(h, w.inB)).status).toBe(200);

    const inside = await reset(hr.accessToken, w.inA.id);
    expect(inside.status).toBe(200);
    expect(inside.body.temporaryPassword).toHaveLength(16);
  });

  it("an HR user without a scope and the Org Admin may reset any employee", async () => {
    const w = await world();
    const hr = await signIn(h, w.hr);
    expect((await reset(hr.accessToken, w.inB.id)).status).toBe(200);
    const admin = await signIn(h, w.admin);
    expect((await reset(admin.accessToken, w.inA.id)).status).toBe(200);
  });

  it("a one-time password stops working after 72 hours, and a reset gives a fresh one", async () => {
    const w = await world();
    const admin = await signIn(h, w.admin);
    const r = await reset(admin.accessToken, w.inA.id);
    const user = { ...w.inA, password: r.body.temporaryPassword as string };
    const row = await h.owner.query<{ hours: number }>(
      "SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 AS hours FROM user_account WHERE id = $1",
      [w.inA.id],
    );
    expect(Number(row.rows[0]!.hours)).toBeGreaterThan(71);
    expect(Number(row.rows[0]!.hours)).toBeLessThanOrEqual(72);

    expect((await login(h, user)).status).toBe(200); // within the time

    await h.owner.query(
      "UPDATE user_account SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1",
      [w.inA.id],
    );
    const late = await login(h, user);
    expect([late.status, late.body.code]).toEqual([401, "TEMP_PASSWORD_EXPIRED"]);
    // a wrong password is still the same answer as always, not the expiry message
    expect((await login(h, user, "wrong-password-xyz")).body.code).toBe("INVALID_CREDENTIALS");

    const again = await reset(admin.accessToken, w.inA.id);
    expect((await login(h, { ...w.inA, password: again.body.temporaryPassword })).status).toBe(200);
  });

  it("choosing your own password ends the expiry and the reset notice", async () => {
    const w = await world();
    const admin = await signIn(h, w.admin);
    const r = await reset(admin.accessToken, w.inA.id);
    const first = await login(h, { ...w.inA, password: r.body.temporaryPassword });
    expect(first.body.tokens.user.passwordReset).toMatchObject({ by: "ORG_ADMIN" });
    const changed = await h
      .http()
      .post("/v1/auth/password/change")
      .set(bearer(first.body.tokens.accessToken))
      .send({ currentPassword: r.body.temporaryPassword, newPassword: "My own new passphrase 77" });
    expect(changed.status).toBe(200);
    expect(changed.body.user.passwordReset).toBeNull();
    const row = await h.owner.query<{
      temp_password_expires_at: Date | null;
      password_reset_at: Date | null;
    }>("SELECT temp_password_expires_at, password_reset_at FROM user_account WHERE id = $1", [
      w.inA.id,
    ]);
    expect(row.rows[0]).toEqual({ temp_password_expires_at: null, password_reset_at: null });
  });

  it("every admin-made reset is announced to the Organization Admins, in generic words", async () => {
    const w = await world();
    const hr = await signIn(h, w.hr);
    await reset(hr.accessToken, w.inA.id);
    const admin = await signIn(h, w.admin);
    await h.http().post(`/v1/users/${w.hr.id}/totp-reset`).set(bearer(admin.accessToken)).send({});
    const { rows } = await h.owner.query<{ title: string; body: string; user_id: string }>(
      "SELECT title, body, user_id FROM notification WHERE tenant_id = $1 AND kind = 'PASSWORD_RESET'",
      [w.tenant.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === w.admin.id)).toBe(true);
    // no names in a text that travels through a push service
    expect(rows.map((r) => r.title + r.body).join(" ")).not.toMatch(/in\.a|hr|Ажилтан/u);
  });
});
