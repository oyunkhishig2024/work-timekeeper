import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { attendanceKit, WORK_DATE } from "./attendance-kit";
import {
  auditActions,
  createEmployee,
  createUser,
  type Harness,
  signConsentSql,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)(
  "Org Admin, HR and Manager record their own attendance on a phone (PRD 4)",
  () => {
    let h: Harness;
    let k: ReturnType<typeof attendanceKit>;
    beforeAll(async () => {
      h = await startHarness();
      k = attendanceKit(h);
    });
    afterAll(async () => {
      await h.close();
    });

    const put = (token: string, url: string, body: object) =>
      h
        .http()
        .put(url)
        .set({ Authorization: `Bearer ${token}` })
        .send(body);

    it("an HR account linked to the person's employee record registers a phone and is on time, and still uses the web app", async () => {
      const w = await k.world();
      const self = await createEmployee(h, w.tenant, { name: "Ганбат Хүний нөөц" });
      await signConsentSql(h, w.tenant.id, self.id);
      const admin = (await signIn(h, w.admin)).accessToken;

      const linked = await put(admin, `/v1/users/${w.hr.id}/employee`, { employeeId: self.id });
      expect(linked.status).toBe(200);
      expect(
        (await k.get(admin, "/v1/users")).body.find((u: { id: string }) => u.id === w.hr.id),
      ).toMatchObject({
        employeeId: self.id,
        employeeName: "Ганбат Хүний нөөц",
      });
      expect(await auditActions(h, w.tenant.id)).toContain("user.employee_linked");

      // the phone: sign in as HR (two-step login), register with a QR from the HR desk, send events
      k.setClock("07:30");
      const phoneTokens = await signIn(h, w.hr);
      const phone = phoneTokens.accessToken;
      const qr = (await k.post(phone, "/v1/qr/onboarding")).body;
      const reg = await k.post(phone, "/v1/devices/register", {
        qrToken: qr.token,
        platform: "ANDROID",
        attestationKeyId: `key-${Math.random().toString(36).slice(2)}`,
      });
      expect(reg.status).toBe(201);
      // the phone session now lasts like an employee's, not like a web session
      const session = await h.owner.query<{ expiresAt: Date }>(
        'SELECT max(expires_at) AS "expiresAt" FROM auth_session WHERE user_id = $1 AND device_id IS NOT NULL',
        [w.hr.id],
      );
      const days = (session.rows[0]!.expiresAt.getTime() - h.clock.now().getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(5);

      k.setClock("08:05");
      const renewed = await h
        .http()
        .post("/v1/auth/refresh")
        .send({ refreshToken: phoneTokens.refreshToken });
      expect(renewed.status).toBe(200);
      const sender = renewed.body.accessToken as string;
      const sent = await k.post(sender, "/v1/events", { events: [k.ev(w)] });
      expect(sent.status).toBeLessThan(300);
      k.setClock("08:30");
      await k.tick(w.tenant.id);
      expect(
        (
          await h.owner.query(
            "SELECT status FROM attendance_result WHERE employee_id = $1 AND work_date = $2",
            [self.id, WORK_DATE],
          )
        ).rows[0],
      ).toMatchObject({ status: "ON_TIME" });
      const again = await h
        .http()
        .post("/v1/auth/refresh")
        .send({ refreshToken: renewed.body.refreshToken });
      const mine = await k.get(
        again.body.accessToken,
        `/v1/me/attendance?from=${WORK_DATE}&to=${WORK_DATE}`,
      );
      expect(mine.body.items[0]).toMatchObject({ status: "ON_TIME" });

      // and the web app is unchanged: HR still reads the daily list and sees themself in it
      const hr = (await signIn(h, w.hr)).accessToken;
      const day = (await k.get(hr, `/v1/attendance/daily?date=${WORK_DATE}`)).body;
      expect(day.items.some((r: { employeeId: string }) => r.employeeId === self.id)).toBe(true);
    });

    it("a Manager and an Org Admin can be linked too; one login per employee; employee logins are not relinked", async () => {
      const w = await k.world();
      const admin = (await signIn(h, w.admin)).accessToken;
      const mgr = await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" });
      const a = await createEmployee(h, w.tenant);
      const b = await createEmployee(h, w.tenant);
      expect((await put(admin, `/v1/users/${mgr.id}/employee`, { employeeId: a.id })).status).toBe(
        200,
      );
      // an Org Admin links their own account
      expect(
        (await put(admin, `/v1/users/${w.admin.id}/employee`, { employeeId: b.id })).status,
      ).toBe(200);
      // the same employee cannot have two logins
      const clash = await put(admin, `/v1/users/${w.hr.id}/employee`, { employeeId: a.id });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe("EMPLOYEE_HAS_ACCOUNT");
      // an employee who already has their own employee login is refused
      expect(
        (await put(admin, `/v1/users/${w.hr.id}/employee`, { employeeId: w.employee.id })).status,
      ).toBe(409);
      // an employee login cannot be moved
      expect(
        (await put(admin, `/v1/users/${w.user.id}/employee`, { employeeId: a.id })).status,
      ).toBe(409);
      // unlink, validation, rights
      const admin2 = (await signIn(h, w.admin)).accessToken;
      expect((await put(admin2, `/v1/users/${mgr.id}/employee`, { employeeId: null })).status).toBe(
        200,
      );
      expect(
        (await put(admin2, `/v1/users/${mgr.id}/employee`, { employeeId: "nope" })).status,
      ).toBe(400);
      expect(
        (
          await put(admin2, `/v1/users/${mgr.id}/employee`, {
            employeeId: "00000000-0000-4000-8000-000000000000",
          })
        ).status,
      ).toBe(404);
      const hrToken = (await signIn(h, w.hr)).accessToken;
      expect(
        (await put(hrToken, `/v1/users/${mgr.id}/employee`, { employeeId: a.id })).status,
      ).toBe(403);
    });

    it("a staff account without an employee record cannot record attendance", async () => {
      const w = await k.world();
      const hr = (await signIn(h, w.hr)).accessToken;
      const res = await k.get(hr, `/v1/me/attendance?from=${WORK_DATE}&to=${WORK_DATE}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EMPLOYEE_ONLY");
    });
  },
);
