import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIn } from "../../src/common/dates";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createConsentText,
  createTenant,
  createUser,
  type Harness,
  signConsentSql,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)("employees (PRD 12)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const today = () => todayIn("Asia/Ulaanbaatar", h.clock.now());
  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);
  const patch = (token: string, url: string, body: object) =>
    h.http().patch(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));

  /** A tenant with admin/HR/manager signed in, two departments and two locations. */
  async function world() {
    const tenant = await createTenant(h);
    await createConsentText(h, tenant);
    const adminUser = await createUser(h, tenant, {
      username: "admin",
      role: "ORG_ADMIN",
      totp: true,
    });
    const hrUser = await createUser(h, tenant, { username: "hr", role: "HR", totp: true });
    const mgrUser = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
    const admin = (await signIn(h, adminUser)).accessToken;
    const hr = (await signIn(h, hrUser)).accessToken;
    const mgr = (await signIn(h, mgrUser)).accessToken;
    const dept = async (name: string) =>
      (await post(admin, "/v1/departments", { name })).body.id as string;
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    const [hrDept, financeDept] = [await dept("Хүний нөөц"), await dept("Санхүү")];
    const [central, naimanSharga] = [await loc("Төв салбар"), await loc("Найман шарга")];
    const create = async (
      no: string,
      name: string,
      departmentId = hrDept,
      primaryLocationId = central,
      token = hr,
    ) =>
      (
        await post(token, "/v1/employees", {
          employeeNo: no,
          fullName: name,
          departmentId,
          primaryLocationId,
        })
      ).body;
    return {
      tenant,
      adminUser,
      hrUser,
      mgrUser,
      admin,
      hr,
      mgr,
      hrDept,
      financeDept,
      central,
      naimanSharga,
      create,
    };
  }

  describe("create, read and update", () => {
    it("HR creates an employee; the number is unique; references must exist and be active", async () => {
      const w = await world();
      const res = await post(w.hr, "/v1/employees", {
        employeeNo: "E-001",
        fullName: "Бадам Гэндэн",
        departmentId: w.hrDept,
        primaryLocationId: w.central,
        startDate: "2026-10-01",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        employeeNo: "E-001",
        fullName: "Бадам Гэндэн",
        status: "ACTIVE",
        departmentName: "Хүний нөөц",
        locationName: "Төв салбар",
        startDate: "2026-10-01",
        endDate: null,
        scheduleMode: "STANDARD",
        manualAttendance: false,
        consentStatus: "NOT_REQUESTED",
        hasActiveDevice: false,
      });

      const dup = await post(w.hr, "/v1/employees", {
        employeeNo: "E-001",
        fullName: "X",
        departmentId: w.hrDept,
        primaryLocationId: w.central,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("EMPLOYEE_NO_TAKEN");

      const ghost = "00000000-0000-4000-8000-000000000000";
      expect(
        (
          await post(w.hr, "/v1/employees", {
            employeeNo: "E-2",
            fullName: "X",
            departmentId: ghost,
            primaryLocationId: w.central,
          })
        ).body.code,
      ).toBe("DEPARTMENT_NOT_FOUND");
      expect(
        (
          await post(w.hr, "/v1/employees", {
            employeeNo: "E-2",
            fullName: "X",
            departmentId: w.hrDept,
            primaryLocationId: ghost,
          })
        ).body.code,
      ).toBe("LOCATION_NOT_FOUND");
      await patchDepartment(w.admin, w.financeDept, { active: false });
      expect(
        (
          await post(w.hr, "/v1/employees", {
            employeeNo: "E-2",
            fullName: "X",
            departmentId: w.financeDept,
            primaryLocationId: w.central,
          })
        ).body.code,
      ).toBe("DEPARTMENT_INACTIVE");
      expect(await auditActions(h, w.tenant.id)).toContain("employee.created");
    });
    const patchDepartment = (token: string, id: string, body: object) =>
      patch(token, `/v1/departments/${id}`, body);

    it("validates input and enforces roles", async () => {
      const w = await world();
      const base = {
        employeeNo: "E-9",
        fullName: "Name",
        departmentId: w.hrDept,
        primaryLocationId: w.central,
      };
      expect((await post(w.hr, "/v1/employees", { ...base, fullName: "" })).status).toBe(400);
      expect((await post(w.hr, "/v1/employees", { ...base, startDate: "2026-02-30" })).status).toBe(
        400,
      );
      expect((await post(w.hr, "/v1/employees", { ...base, nickname: "x" })).status).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/employees", {
            ...base,
            startDate: "2026-10-10",
            endDate: "2026-10-01",
          })
        ).body.code,
      ).toBe("INVALID_DATES");
      expect((await post(w.mgr, "/v1/employees", base)).status).toBe(403);
      expect((await h.http().post("/v1/employees").send(base)).status).toBe(401);
      expect((await post(w.admin, "/v1/employees", base)).status).toBe(201);
    });

    it("shows an employee's detail with account and device, and hides other tenants", async () => {
      const w = await world();
      const e = await w.create("E-1", "Бадам Гэндэн");
      const detail = await get(w.hr, `/v1/employees/${e.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ id: e.id, account: null, device: null });
      expect((await get(w.hr, "/v1/employees/not-a-uuid")).status).toBe(400);
      expect((await get(w.hr, "/v1/employees/00000000-0000-4000-8000-000000000000")).status).toBe(
        404,
      );

      const other = await world();
      expect((await get(other.hr, `/v1/employees/${e.id}`)).status).toBe(404);
      expect((await patch(other.hr, `/v1/employees/${e.id}`, { fullName: "Hacked" })).status).toBe(
        404,
      );
      expect((await post(other.hr, `/v1/employees/${e.id}/disable`)).status).toBe(404);
      expect((await get(other.hr, "/v1/employees")).body.total).toBe(0);
    });

    it("updates fields, records before/after in the audit log, and ignores no-op edits", async () => {
      const w = await world();
      const e = await w.create("E-1", "Бадам Гэндэн");
      const res = await patch(w.hr, `/v1/employees/${e.id}`, {
        fullName: "Бадам Гэндэн-Эрдэнэ",
        departmentId: w.financeDept,
        primaryLocationId: w.naimanSharga,
        scheduleMode: "SHIFT",
        manualAttendance: true,
        startDate: "2026-09-01",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        fullName: "Бадам Гэндэн-Эрдэнэ",
        departmentName: "Санхүү",
        locationName: "Найман шарга",
        scheduleMode: "SHIFT",
        manualAttendance: true,
        startDate: "2026-09-01",
      });
      const trail = await h.owner.query(
        "SELECT before, after FROM audit_log WHERE action = 'employee.updated' AND tenant_id = $1",
        [w.tenant.id],
      );
      expect(trail.rows).toHaveLength(1);
      expect(trail.rows[0].before).toMatchObject({
        full_name: "Бадам Гэндэн",
        schedule_mode: "STANDARD",
      });

      await patch(w.hr, `/v1/employees/${e.id}`, { fullName: "Бадам Гэндэн-Эрдэнэ" }); // nothing changed
      expect(
        (
          await h.owner.query(
            "SELECT count(*)::int AS n FROM audit_log WHERE action = 'employee.updated' AND tenant_id = $1",
            [w.tenant.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect((await patch(w.hr, `/v1/employees/${e.id}`, {})).status).toBe(400);
      expect((await patch(w.mgr, `/v1/employees/${e.id}`, { fullName: "x" })).status).toBe(403);
      const second = await w.create("E-2", "Other");
      expect(
        (await patch(w.hr, `/v1/employees/${e.id}`, { employeeNo: second.employeeNo })).body.code,
      ).toBe("EMPLOYEE_NO_TAKEN");
      expect(
        (
          await patch(w.hr, `/v1/employees/${e.id}`, {
            startDate: "2026-12-01",
            endDate: "2026-11-01",
          })
        ).body.code,
      ).toBe("INVALID_DATES");
    });
  });

  describe("searching and listing", () => {
    it("searches names (Cyrillic, any case) and numbers; % and _ are not wildcards", async () => {
      const w = await world();
      await w.create("A-100", "Өлзийбат Үүрцайх");
      await w.create("A-200", "Бадам Гэндэн");
      await w.create("B-300", "100% Нарантуяа");
      const names = async (q: string) =>
        (await get(w.hr, `/v1/employees?q=${encodeURIComponent(q)}`)).body.items.map(
          (e: { fullName: string }) => e.fullName,
        );

      expect(await names("өлзий")).toEqual(["Өлзийбат Үүрцайх"]);
      expect(await names("ӨЛЗИЙБАТ")).toEqual(["Өлзийбат Үүрцайх"]);
      expect(await names("ГЭНДЭН")).toEqual(["Бадам Гэндэн"]);
      expect(await names("a-2")).toEqual(["Бадам Гэндэн"]);
      expect(await names("100%")).toEqual(["100% Нарантуяа"]);
      expect(await names("%")).toEqual(["100% Нарантуяа"]);
      expect(await names("_")).toEqual([]);
      expect(await names("zzz")).toEqual([]);
    });

    it("hides disabled and archived employees by default and filters by department, location and more", async () => {
      const w = await world();
      const a = await w.create("E-1", "Alpha", w.hrDept, w.central);
      const b = await w.create("E-2", "Bravo", w.financeDept, w.naimanSharga);
      const c = await w.create("E-3", "Charlie", w.hrDept, w.naimanSharga);
      await h.owner.query("UPDATE employee SET status = 'DISABLED' WHERE id = $1", [c.id]);
      await patch(w.hr, `/v1/employees/${b.id}`, { manualAttendance: true });
      await signConsentSql(h, w.tenant.id, a.id);
      const ids = async (qs: string) =>
        (await get(w.hr, `/v1/employees?${qs}`)).body.items.map((e: { id: string }) => e.id).sort();

      expect(await ids("")).toEqual([a.id, b.id].sort());
      expect(await ids("status=DISABLED")).toEqual([c.id]);
      expect(await ids("status=ALL")).toEqual([a.id, b.id, c.id].sort());
      expect(await ids(`departmentId=${w.financeDept}`)).toEqual([b.id]);
      expect(await ids(`locationId=${w.naimanSharga}&status=ALL`)).toEqual([b.id, c.id].sort());
      expect(await ids("manualAttendance=true")).toEqual([b.id]);
      expect(await ids("consentStatus=SIGNED")).toEqual([a.id]);
      expect(await ids("consentStatus=NOT_REQUESTED")).toEqual([b.id]);
      expect(await ids("hasDevice=false")).toEqual([a.id, b.id].sort());
      expect(await ids("hasDevice=true")).toEqual([]);
      expect((await get(w.hr, "/v1/employees?status=BOGUS")).status).toBe(400);
      expect((await get(w.hr, "/v1/employees?limit=1000")).status).toBe(400);
    });

    it("sorts and pages with a total", async () => {
      const w = await world();
      for (const [no, name] of [
        ["E-1", "Cc"],
        ["E-2", "Aa"],
        ["E-3", "Bb"],
      ])
        await w.create(no!, name!);
      const page = await get(w.hr, "/v1/employees?sort=fullName&order=desc&limit=2&offset=0");
      expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
      expect(page.body.items.map((e: { fullName: string }) => e.fullName)).toEqual(["Cc", "Bb"]);
      const next = await get(w.hr, "/v1/employees?sort=fullName&order=desc&limit=2&offset=2");
      expect(next.body.items.map((e: { fullName: string }) => e.fullName)).toEqual(["Aa"]);
    });
  });

  describe("data scope (PRD 4)", () => {
    it("a Manager sees nothing until a scope is assigned, then only that scope", async () => {
      const w = await world();
      const inCentral = await w.create("E-1", "Central person", w.hrDept, w.central);
      const inFinance = await w.create("E-2", "Finance person", w.financeDept, w.naimanSharga);
      const elsewhere = await w.create("E-3", "Other person", w.hrDept, w.naimanSharga);

      expect((await get(w.mgr, "/v1/employees")).body).toMatchObject({ total: 0, items: [] });
      expect((await get(w.mgr, `/v1/employees/${inCentral.id}`)).status).toBe(404);

      const scope = await h
        .http()
        .put(`/v1/users/${w.mgrUser.id}/scope`)
        .set(bearer(w.admin))
        .send({ locationIds: [w.central], departmentIds: [w.financeDept] });
      expect(scope.status).toBe(200);
      const seen = (await get(w.mgr, "/v1/employees")).body.items
        .map((e: { id: string }) => e.id)
        .sort();
      expect(seen).toEqual([inCentral.id, inFinance.id].sort());
      expect((await get(w.mgr, `/v1/employees/${inFinance.id}`)).status).toBe(200);
      expect((await get(w.mgr, `/v1/employees/${elsewhere.id}`)).status).toBe(404);
      expect((await get(w.mgr, `/v1/employees?q=Other`)).body.total).toBe(0);
      expect(
        (await get(w.mgr, `/v1/employees?locationId=${w.naimanSharga}`)).body.items.map(
          (e: { id: string }) => e.id,
        ),
      ).toEqual([inFinance.id]);
    });

    it("HR is limited only when given a scope, and cannot create or edit outside it", async () => {
      const w = await world();
      const inCentral = await w.create("E-1", "Central person", w.hrDept, w.central);
      const away = await w.create("E-2", "Away person", w.financeDept, w.naimanSharga);
      expect((await get(w.hr, "/v1/employees")).body.total).toBe(2);

      await h
        .http()
        .put(`/v1/users/${w.hrUser.id}/scope`)
        .set(bearer(w.admin))
        .send({ locationIds: [w.central] });
      expect(
        (await get(w.hr, "/v1/employees")).body.items.map((e: { id: string }) => e.id),
      ).toEqual([inCentral.id]);
      expect((await get(w.hr, `/v1/employees/${away.id}`)).status).toBe(404);
      expect((await patch(w.hr, `/v1/employees/${away.id}`, { fullName: "x" })).status).toBe(404);
      expect(
        (
          await post(w.hr, "/v1/employees", {
            employeeNo: "E-9",
            fullName: "New",
            departmentId: w.financeDept,
            primaryLocationId: w.naimanSharga,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(w.hr, "/v1/employees", {
            employeeNo: "E-9",
            fullName: "New",
            departmentId: w.financeDept,
            primaryLocationId: w.central,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await patch(w.hr, `/v1/employees/${inCentral.id}`, {
            primaryLocationId: w.naimanSharga,
            departmentId: w.hrDept,
          })
        ).status,
      ).toBe(403);
      expect((await get(w.admin, "/v1/employees")).body.total).toBe(3); // Org Admin always sees all
    });

    it("only the Org Admin sets scopes, and only for HR and Manager accounts", async () => {
      const w = await world();
      const url = (id: string) => `/v1/users/${id}/scope`;
      const body = { locationIds: [w.central], departmentIds: [] };
      expect((await h.http().put(url(w.mgrUser.id)).set(bearer(w.hr)).send(body)).status).toBe(403);
      expect(
        (await h.http().put(url(w.adminUser.id)).set(bearer(w.admin)).send(body)).body.code,
      ).toBe("SCOPE_NOT_APPLICABLE");
      expect(
        (
          await h
            .http()
            .put(url(w.mgrUser.id))
            .set(bearer(w.admin))
            .send({ locationIds: ["00000000-0000-4000-8000-000000000000"] })
        ).body.code,
      ).toBe("LOCATION_NOT_FOUND");
      expect(
        (
          await h
            .http()
            .put(url("00000000-0000-4000-8000-000000000000"))
            .set(bearer(w.admin))
            .send(body)
        ).status,
      ).toBe(404);

      expect((await h.http().put(url(w.mgrUser.id)).set(bearer(w.admin)).send(body)).status).toBe(
        200,
      );
      expect((await get(w.admin, url(w.mgrUser.id))).body).toEqual({
        locationIds: [w.central],
        departmentIds: [],
      });
      await h.http().put(url(w.mgrUser.id)).set(bearer(w.admin)).send({}); // clears the scope again
      expect((await get(w.admin, url(w.mgrUser.id))).body).toEqual({
        locationIds: [],
        departmentIds: [],
      });

      const users = await get(w.admin, "/v1/users");
      expect(users.body.map((u: { username: string }) => u.username)).toEqual([
        "admin",
        "hr",
        "mgr",
      ]);
      expect((await get(w.hr, "/v1/users")).status).toBe(403);
      expect(await auditActions(h, w.tenant.id)).toContain("user.scope_set");
    });
  });

  describe("login account", () => {
    it("HR gives an active employee a login with a one-time password", async () => {
      const w = await world();
      const e = await w.create("E-1", "Бадам Гэндэн");
      const created = await post(w.hr, `/v1/employees/${e.id}/account`, { username: "badam" });
      expect(created.status).toBe(201);
      expect(created.body.temporaryPassword).toHaveLength(16);

      const login = await h.http().post("/v1/auth/login").send({
        orgCode: w.tenant.code,
        username: "badam",
        password: created.body.temporaryPassword,
      });
      expect(login.body.tokens.requires).toEqual(["PASSWORD_CHANGE"]);
      expect(login.body.tokens.user.role).toBe("EMPLOYEE");

      expect(
        (await post(w.hr, `/v1/employees/${e.id}/account`, { username: "other" })).body.code,
      ).toBe("ACCOUNT_EXISTS");
      const second = await w.create("E-2", "Second");
      expect(
        (await post(w.hr, `/v1/employees/${second.id}/account`, { username: "BADAM" })).body.code,
      ).toBe("USERNAME_TAKEN");
      expect(
        (await post(w.hr, `/v1/employees/${second.id}/account`, { username: "x" })).status,
      ).toBe(400);
      expect(
        (await post(w.mgr, `/v1/employees/${second.id}/account`, { username: "second" })).status,
      ).toBe(403);
      expect((await get(w.hr, `/v1/employees/${e.id}`)).body.account).toMatchObject({
        username: "badam",
        status: "ACTIVE",
      });
      expect(await auditActions(h, w.tenant.id)).toContain("employee.account_created");
    });
  });

  describe("lifecycle (PRD 12.2)", () => {
    /** An employee with a login, a registered device, signed consent, temporary assignments and an open QR. */
    async function busyEmployee() {
      const w = await world();
      const e = await w.create("E-1", "Бадам Гэндэн");
      const account = (await post(w.hr, `/v1/employees/${e.id}/account`, { username: "badam" }))
        .body;
      await signConsentSql(h, w.tenant.id, e.id);
      // The temporary password must be changed first; do it through the API to get usable tokens.
      const first = (
        await h
          .http()
          .post("/v1/auth/login")
          .send({ orgCode: w.tenant.code, username: "badam", password: account.temporaryPassword })
      ).body.tokens;
      const changed = (
        await post(first.accessToken, "/v1/auth/password/change", {
          currentPassword: account.temporaryPassword,
          newPassword: "A fine new passphrase",
        })
      ).body;
      const qr = (await post(w.hr, "/v1/qr/onboarding", {})).body;
      const reg = await post(changed.accessToken, "/v1/devices/register", {
        qrToken: qr.token,
        platform: "ANDROID",
        attestationKeyId: `k-${e.id}`,
      });
      expect(reg.status).toBe(201);
      const replacementQr = (await post(w.hr, `/v1/employees/${e.id}/replacement-qr`)).body;
      const day = (offset: number) =>
        new Date(h.clock.now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      const assign = (from: string, to: string) =>
        h.owner.query(
          "INSERT INTO temp_location_assignment (tenant_id, employee_id, location_id, from_date, to_date) VALUES ($1, $2, $3, $4, $5)",
          [w.tenant.id, e.id, w.naimanSharga, from, to],
        );
      await assign(day(-2), day(5)); // running now
      await assign(day(10), day(12)); // in the future
      return {
        w,
        e,
        account,
        empToken: changed.accessToken as string,
        deviceId: reg.body.deviceId as string,
        replacementQr,
        day,
      };
    }

    it("disable: blocks login, ends sessions, deactivates the device, trims assignments, cancels QR codes", async () => {
      const { w, e, empToken, deviceId, replacementQr } = await busyEmployee();
      expect((await get(empToken, "/v1/devices/me")).status).toBe(200);

      // A second session that is not tied to the device (for example the web or another login).
      const extra = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: w.tenant.code, username: "badam", password: "A fine new passphrase" });
      expect(extra.status).toBe(200);
      const res = await post(w.hr, `/v1/employees/${e.id}/disable`, { reason: "Ажлаас гарсан" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "DISABLED",
        endDate: today(),
        deviceDisabled: true,
        accountDisabled: true,
        temporaryAssignmentsEnded: 1,
        temporaryAssignmentsRemoved: 1,
      });

      expect((await get(empToken, "/v1/devices/me")).status).toBe(401); // session ended immediately
      expect(
        (
          await h.owner.query(
            "SELECT count(*)::int AS n FROM auth_session s JOIN user_account u ON u.id = s.user_id WHERE u.employee_id = $1 AND s.revoked_at IS NULL",
            [e.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await h
            .http()
            .post("/v1/auth/login")
            .send({ orgCode: w.tenant.code, username: "badam", password: "A fine new passphrase" })
        ).status,
      ).toBe(401);
      expect(
        (
          await h.owner.query("SELECT status, disabled_reason FROM device WHERE id = $1", [
            deviceId,
          ])
        ).rows[0],
      ).toEqual({ status: "DISABLED", disabled_reason: "EMPLOYEE_DISABLED" });
      const assignments = await h.owner.query(
        "SELECT to_date::text FROM temp_location_assignment WHERE employee_id = $1",
        [e.id],
      );
      expect(assignments.rows).toEqual([{ to_date: today() }]);
      expect(
        (
          await h.owner.query("SELECT cancelled_at FROM onboarding_qr WHERE id = $1", [
            replacementQr.id,
          ])
        ).rows[0].cancelled_at,
      ).not.toBeNull();

      expect((await get(w.hr, "/v1/employees")).body.total).toBe(0); // hidden by default
      expect((await get(w.hr, "/v1/employees?status=DISABLED")).body.items[0]).toMatchObject({
        id: e.id,
        status: "DISABLED",
        endDate: today(),
      });
      expect((await post(w.hr, `/v1/employees/${e.id}/disable`)).body.code).toBe(
        "EMPLOYEE_NOT_ACTIVE",
      );
      expect(await auditActions(h, w.tenant.id)).toContain("employee.disabled");
      expect(
        (await patch(w.hr, `/v1/employees/${e.id}`, { fullName: "Бадам Гэндэн (өмнөх)" })).status,
      ).toBe(200); // disabled records stay editable
    });

    it("disable: validates the effective date", async () => {
      const w = await world();
      const e = (
        await post(w.hr, "/v1/employees", {
          employeeNo: "E-1",
          fullName: "X",
          departmentId: w.hrDept,
          primaryLocationId: w.central,
          startDate: "2026-09-01",
        })
      ).body;
      expect(
        (await post(w.hr, `/v1/employees/${e.id}/disable`, { effectiveDate: "2099-01-01" })).body
          .code,
      ).toBe("EFFECTIVE_DATE_IN_FUTURE");
      expect(
        (await post(w.hr, `/v1/employees/${e.id}/disable`, { effectiveDate: "2026-08-01" })).body
          .code,
      ).toBe("EFFECTIVE_DATE_BEFORE_START");
      expect(
        (await post(w.hr, `/v1/employees/${e.id}/disable`, { effectiveDate: "yesterday" })).status,
      ).toBe(400);
      const ok = await post(w.hr, `/v1/employees/${e.id}/disable`, { effectiveDate: "2026-09-15" });
      expect(ok.body).toMatchObject({
        endDate: "2026-09-15",
        deviceDisabled: false,
        accountDisabled: false,
      });
      expect((await post(w.mgr, `/v1/employees/${e.id}/disable`)).status).toBe(403);
    });

    it("reactivate: re-confirms department and location, resets the password, keeps the old device disabled", async () => {
      const { w, e, deviceId } = await busyEmployee();
      await post(w.hr, `/v1/employees/${e.id}/disable`);
      expect((await post(w.hr, `/v1/employees/${e.id}/reactivate`, {})).status).toBe(400);

      await patch(w.admin, `/v1/departments/${w.financeDept}`, { active: false });
      expect(
        (
          await post(w.hr, `/v1/employees/${e.id}/reactivate`, {
            departmentId: w.financeDept,
            primaryLocationId: w.central,
          })
        ).body.code,
      ).toBe("DEPARTMENT_INACTIVE");

      const res = await post(w.hr, `/v1/employees/${e.id}/reactivate`, {
        departmentId: w.hrDept,
        primaryLocationId: w.naimanSharga,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "ACTIVE",
        startDate: today(),
        deviceRegistrationRequired: true,
      });
      expect(res.body.temporaryPassword).toHaveLength(16);

      const detail = (await get(w.hr, `/v1/employees/${e.id}`)).body;
      expect(detail).toMatchObject({
        status: "ACTIVE",
        endDate: null,
        locationName: "Найман шарга",
        hasActiveDevice: false,
        device: null,
      });
      expect(
        (await h.owner.query("SELECT status FROM device WHERE id = $1", [deviceId])).rows[0].status,
      ).toBe("DISABLED");
      const login = await h
        .http()
        .post("/v1/auth/login")
        .send({ orgCode: w.tenant.code, username: "badam", password: res.body.temporaryPassword });
      expect(login.body.tokens.requires).toEqual(["PASSWORD_CHANGE"]);
      expect(
        (
          await post(w.hr, `/v1/employees/${e.id}/reactivate`, {
            departmentId: w.hrDept,
            primaryLocationId: w.central,
          })
        ).body.code,
      ).toBe("EMPLOYEE_ALREADY_ACTIVE");
      expect(await auditActions(h, w.tenant.id)).toContain("employee.reactivated");
    });

    it("archive: only after the retention period (Org Admin may force); archived records are read-only", async () => {
      const w = await world();
      const e = await w.create("E-1", "Leaver");
      expect((await post(w.hr, `/v1/employees/${e.id}/archive`)).body.code).toBe(
        "EMPLOYEE_NOT_DISABLED",
      );
      await post(w.hr, `/v1/employees/${e.id}/disable`);

      const early = await post(w.hr, `/v1/employees/${e.id}/archive`);
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: "ARCHIVE_TOO_EARLY", retentionMonths: 12 });
      expect((await post(w.hr, `/v1/employees/${e.id}/archive`, { force: true })).body.code).toBe(
        "ARCHIVE_TOO_EARLY",
      ); // HR cannot force
      expect(
        (await post(w.admin, `/v1/employees/${e.id}/archive`, { force: true })).body.status,
      ).toBe("ARCHIVED");
      expect(
        (await post(w.admin, `/v1/employees/${e.id}/archive`, { force: true })).body.code,
      ).toBe("EMPLOYEE_NOT_DISABLED");

      expect((await patch(w.hr, `/v1/employees/${e.id}`, { fullName: "x" })).body.code).toBe(
        "EMPLOYEE_ARCHIVED",
      );
      expect((await get(w.hr, "/v1/employees?status=ALL")).body.total).toBe(1);
      expect((await get(w.hr, "/v1/employees")).body.total).toBe(0);

      // Restored by re-activation, which reuses the same record.
      const back = await post(w.hr, `/v1/employees/${e.id}/reactivate`, {
        departmentId: w.hrDept,
        primaryLocationId: w.central,
      });
      expect(back.body.status).toBe("ACTIVE");

      // After the retention period archiving works without force.
      const f = await w.create("E-2", "Long gone");
      await post(w.hr, `/v1/employees/${f.id}/disable`, { effectiveDate: "2024-01-31" });
      expect((await post(w.hr, `/v1/employees/${f.id}/archive`)).body.status).toBe("ARCHIVED");
      expect(await auditActions(h, w.tenant.id)).toContain("employee.archived");
    });

    it("an employee cannot be deleted through the API", async () => {
      const w = await world();
      const e = await w.create("E-1", "Keeper");
      expect((await h.http().delete(`/v1/employees/${e.id}`).set(bearer(w.admin))).status).toBe(
        404,
      );
    });
  });
});
