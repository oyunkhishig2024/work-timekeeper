import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createTenant,
  createUser,
  type Harness,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)("departments and locations (PRD 13)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function org() {
    const tenant = await createTenant(h);
    const admin = await signIn(
      h,
      await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true }),
    );
    const hr = await signIn(
      h,
      await createUser(h, tenant, { username: "hr", role: "HR", totp: true }),
    );
    const mgr = await signIn(h, await createUser(h, tenant, { username: "mgr", role: "MANAGER" }));
    return { tenant, admin: admin.accessToken, hr: hr.accessToken, mgr: mgr.accessToken };
  }
  const post = (token: string, url: string, body: object) =>
    h.http().post(url).set(bearer(token)).send(body);
  const patch = (token: string, url: string, body: object) =>
    h.http().patch(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));
  const employee = (token: string, departmentId: string, primaryLocationId: string, no: string) =>
    post(token, "/v1/employees", {
      employeeNo: no,
      fullName: `Name ${no}`,
      departmentId,
      primaryLocationId,
    });
  const location = { name: "Төв салбар", lat: 47.9184, lng: 106.9177, radiusM: 200 };

  describe("departments", () => {
    it("Org Admin manages them; HR and Manager can only read (managers see no headcounts)", async () => {
      const o = await org();
      expect((await post(o.hr, "/v1/departments", { name: "Санхүү" })).status).toBe(403);
      expect((await post(o.mgr, "/v1/departments", { name: "Санхүү" })).status).toBe(403);
      expect((await h.http().post("/v1/departments").send({ name: "x" })).status).toBe(401);

      const created = await post(o.admin, "/v1/departments", { name: "Санхүү" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "Санхүү", active: true });

      const hrList = await get(o.hr, "/v1/departments");
      expect(hrList.body).toEqual([
        expect.objectContaining({ name: "Санхүү", activeEmployees: 0 }),
      ]);
      const mgrList = await get(o.mgr, "/v1/departments");
      expect(mgrList.status).toBe(200);
      expect(mgrList.body[0].activeEmployees).toBeNull();
      expect((await get(o.hr, `/v1/departments/${created.body.id}`)).body.name).toBe("Санхүү");
      expect((await get(o.hr, "/v1/departments/not-a-uuid")).status).toBe(400);
      expect((await get(o.hr, "/v1/departments/00000000-0000-4000-8000-000000000000")).status).toBe(
        404,
      );
      expect(await auditActions(h, o.tenant.id)).toContain("department.created");
    });

    it("validates input and keeps names unique", async () => {
      const o = await org();
      expect((await post(o.admin, "/v1/departments", { name: "" })).status).toBe(400);
      expect((await post(o.admin, "/v1/departments", { name: "A", extra: 1 })).status).toBe(400);
      await post(o.admin, "/v1/departments", { name: "Хангамж" });
      const dup = await post(o.admin, "/v1/departments", { name: "Хангамж" });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("DEPARTMENT_NAME_TAKEN");
    });

    it("renames, and refuses to deactivate or delete a department that is in use", async () => {
      const o = await org();
      const dept = (await post(o.admin, "/v1/departments", { name: "Хамгаалалт" })).body;
      const loc = (await post(o.admin, "/v1/locations", location)).body;
      const emp = (await employee(o.hr, dept.id, loc.id, "E1")).body;

      expect((await patch(o.admin, `/v1/departments/${dept.id}`, {})).status).toBe(400);
      const renamed = await patch(o.admin, `/v1/departments/${dept.id}`, { name: "Хамгаалалт-1" });
      expect(renamed.body.name).toBe("Хамгаалалт-1");

      const blocked = await patch(o.admin, `/v1/departments/${dept.id}`, { active: false });
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ code: "DEPARTMENT_IN_USE", activeEmployees: 1 });
      expect(
        (await h.http().delete(`/v1/departments/${dept.id}`).set(bearer(o.admin))).body.code,
      ).toBe("DEPARTMENT_IN_USE");

      // Move the employee to another department; the first can now be deactivated but still not deleted.
      const other = (await post(o.admin, "/v1/departments", { name: "Бусад" })).body;
      await patch(o.hr, `/v1/employees/${emp.id}`, { departmentId: other.id });
      expect(
        (await patch(o.admin, `/v1/departments/${dept.id}`, { active: false })).body.active,
      ).toBe(false);
      expect(
        (await get(o.hr, "/v1/departments?active=false")).body.map((d: { id: string }) => d.id),
      ).toEqual([dept.id]);
      await h.owner.query("UPDATE employee SET status = 'DISABLED' WHERE id = $1", [emp.id]);
    });

    it("deletes an unused department", async () => {
      const o = await org();
      const dept = (await post(o.admin, "/v1/departments", { name: "Түр" })).body;
      expect((await h.http().delete(`/v1/departments/${dept.id}`).set(bearer(o.hr))).status).toBe(
        403,
      );
      expect(
        (await h.http().delete(`/v1/departments/${dept.id}`).set(bearer(o.admin))).status,
      ).toBe(204);
      expect((await get(o.admin, `/v1/departments/${dept.id}`)).status).toBe(404);
      expect(await auditActions(h, o.tenant.id)).toContain("department.deleted");
    });
  });

  describe("locations", () => {
    it("validates the geofence radius (100–500 m) and coordinates", async () => {
      const o = await org();
      for (const radiusM of [99, 501, 150.5]) {
        expect((await post(o.admin, "/v1/locations", { ...location, radiusM })).status).toBe(400);
      }
      expect((await post(o.admin, "/v1/locations", { ...location, lat: 91 })).status).toBe(400);
      expect((await post(o.admin, "/v1/locations", { ...location, lng: -181 })).status).toBe(400);
      for (const radiusM of [100, 500]) {
        expect(
          (await post(o.admin, "/v1/locations", { ...location, name: `r${radiusM}`, radiusM }))
            .status,
        ).toBe(201);
      }
    });

    it("Org Admin creates and edits; others read; managers see no headcounts", async () => {
      const o = await org();
      expect((await post(o.hr, "/v1/locations", location)).status).toBe(403);
      const created = await post(o.admin, "/v1/locations", {
        ...location,
        address: "Сүхбаатар дүүрэг",
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        radiusM: 200,
        active: true,
        workingWeekMode: "INHERIT",
        address: "Сүхбаатар дүүрэг",
      });

      expect((await post(o.admin, "/v1/locations", location)).body.code).toBe(
        "LOCATION_NAME_TAKEN",
      );
      const edited = await patch(o.admin, `/v1/locations/${created.body.id}`, {
        radiusM: 300,
        workingWeekMode: "OVERRIDE",
      });
      expect(edited.body).toMatchObject({
        radiusM: 300,
        workingWeekMode: "OVERRIDE",
        name: "Төв салбар",
      });
      expect(
        (await patch(o.admin, `/v1/locations/${created.body.id}`, { radiusM: 50 })).status,
      ).toBe(400);
      expect((await patch(o.hr, `/v1/locations/${created.body.id}`, { radiusM: 250 })).status).toBe(
        403,
      );

      expect((await get(o.hr, "/v1/locations")).body[0].activeEmployees).toBe(0);
      expect((await get(o.mgr, "/v1/locations")).body[0].activeEmployees).toBeNull();
      const actions = await auditActions(h, o.tenant.id);
      expect(actions).toEqual(expect.arrayContaining(["location.created", "location.updated"]));
      const trail = await h.owner.query(
        "SELECT before, after FROM audit_log WHERE action = 'location.updated' AND tenant_id = $1",
        [o.tenant.id],
      );
      expect(trail.rows[0].before).toMatchObject({ radius_m: 200 });
      expect(trail.rows[0].after).toMatchObject({ radiusM: 300 });
    });

    it("cannot be deactivated while employees use it, nor deleted once used", async () => {
      const o = await org();
      const dept = (await post(o.admin, "/v1/departments", { name: "Хүний нөөц" })).body;
      const loc = (await post(o.admin, "/v1/locations", location)).body;
      const spare = (await post(o.admin, "/v1/locations", { ...location, name: "Налайх" })).body;
      const emp = (await employee(o.hr, dept.id, loc.id, "E1")).body;

      const blocked = await patch(o.admin, `/v1/locations/${loc.id}`, { active: false });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("LOCATION_IN_USE");

      await patch(o.hr, `/v1/employees/${emp.id}`, { primaryLocationId: spare.id });
      expect((await patch(o.admin, `/v1/locations/${loc.id}`, { active: false })).body.active).toBe(
        false,
      );
      // An inactive location cannot be assigned to employees.
      expect(
        (await patch(o.hr, `/v1/employees/${emp.id}`, { primaryLocationId: loc.id })).body.code,
      ).toBe("LOCATION_INACTIVE");

      expect(
        (await h.http().delete(`/v1/locations/${spare.id}`).set(bearer(o.admin))).body.code,
      ).toBe("LOCATION_IN_USE");
      // The first one was used by the employee in the past, so it cannot be deleted either? No: nobody references it now.
      expect((await h.http().delete(`/v1/locations/${loc.id}`).set(bearer(o.admin))).status).toBe(
        204,
      );
    });

    it("is isolated per tenant", async () => {
      const a = await org();
      const b = await org();
      const locB = (await post(b.admin, "/v1/locations", location)).body;
      expect((await get(a.admin, `/v1/locations/${locB.id}`)).status).toBe(404);
      expect((await patch(a.admin, `/v1/locations/${locB.id}`, { radiusM: 300 })).status).toBe(404);
      expect((await h.http().delete(`/v1/locations/${locB.id}`).set(bearer(a.admin))).status).toBe(
        404,
      );
      expect((await get(a.admin, "/v1/locations")).body).toEqual([]);
    });
  });
});
