import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIn } from "../../src/common/dates";
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

describe.skipIf(!hasDb)(
  "rank (цол) and position (албан тушаал) as free text (PRD 12, 22.1)",
  () => {
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
    const put = (token: string, url: string, body: object) =>
      h.http().put(url).set(bearer(token)).send(body);
    const patch = (token: string, url: string, body: object) =>
      h.http().patch(url).set(bearer(token)).send(body);
    const get = (token: string, url: string) => h.http().get(url).set(bearer(token));

    async function world() {
      const tenant = await createTenant(h);
      const admin = (
        await signIn(
          h,
          await createUser(h, tenant, { username: "admin", role: "ORG_ADMIN", totp: true }),
        )
      ).accessToken;
      const hr = (
        await signIn(h, await createUser(h, tenant, { username: "hr", role: "HR", totp: true }))
      ).accessToken;
      const mgrUser = await createUser(h, tenant, { username: "mgr", role: "MANAGER" });
      const mgr = (await signIn(h, mgrUser)).accessToken;
      const dept = (await post(admin, "/v1/departments", { name: "Хамгаалалт" })).body.id as string;
      const loc = (
        await post(admin, "/v1/locations", {
          name: "Төв салбар",
          lat: 47.9,
          lng: 106.9,
          radiusM: 150,
        })
      ).body.id as string;
      const employee = async (extra: object = {}) =>
        (
          await post(hr, "/v1/employees", {
            lastName: "Бат",
            firstName: "Дорж",
            departmentId: dept,
            primaryLocationId: loc,
            ...extra,
          })
        ).body;
      return { tenant, admin, hr, mgr, mgrUser, dept, loc, employee };
    }

    it("creating an employee with a rank and position (any wording) starts both histories; they show on the record and list", async () => {
      const w = await world();
      const e = await w.employee({
        rank: "Ахлах мэргэжилтэн",
        position: "Харуул",
        startDate: "2024-03-01",
      });
      expect(e).toMatchObject({ rank: "Ахлах мэргэжилтэн", position: "Харуул" });
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toEqual([
        expect.objectContaining({
          rank: "Ахлах мэргэжилтэн",
          validFrom: "2024-03-01",
          validTo: null,
        }),
      ]);
      const none = await w.employee({ firstName: "Хоёр" });
      expect(none).toMatchObject({ rank: null, position: null });
      expect((await get(w.hr, `/v1/employees/${none.id}/position-history`)).body).toEqual([]);

      const list = await get(w.hr, "/v1/employees?sort=firstName");
      expect(list.body.items[0]).toMatchObject({ rank: "Ахлах мэргэжилтэн", position: "Харуул" });
      // list filters are case-insensitive and exact
      expect(
        (await get(w.hr, `/v1/employees?rank=${encodeURIComponent("ахлах мэргэжилтэн")}`)).body
          .total,
      ).toBe(1);
      expect((await get(w.hr, "/v1/employees?position=Нярав")).body.total).toBe(0);
      expect((await get(w.hr, "/v1/employees?rank=")).status).toBe(400);
      // blank, over-long and wrongly typed values are refused
      expect((await w.employee({ rank: "   " })).code).toBe("VALIDATION_ERROR");
      expect(
        (
          await post(w.hr, "/v1/employees", {
            lastName: "A",
            firstName: "B",
            departmentId: w.dept,
            primaryLocationId: w.loc,
            rank: "x".repeat(121),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/employees", {
            lastName: "A",
            firstName: "B",
            departmentId: w.dept,
            primaryLocationId: w.loc,
            rank: 5,
          })
        ).status,
      ).toBe(400);
    });

    it("a promotion ends the open rank period and leaves the position history alone", async () => {
      const w = await world();
      const e = await w.employee({ rank: "Дэслэгч", position: "Харуул", startDate: "2020-01-01" });
      const promoted = await put(w.hr, `/v1/employees/${e.id}/rank`, {
        rank: "Ахмад",
        effectiveDate: "2022-06-01",
        note: "Тушаал №12",
      });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toEqual([
        expect.objectContaining({
          rank: "Ахмад",
          validFrom: "2022-06-01",
          validTo: null,
          note: "Тушаал №12",
        }),
        expect.objectContaining({
          rank: "Дэслэгч",
          validFrom: "2020-01-01",
          validTo: "2022-06-01",
        }),
      ]);
      expect((await get(w.hr, `/v1/employees/${e.id}`)).body).toMatchObject({
        rank: "Ахмад",
        position: "Харуул",
      });
      const positions = await get(w.hr, `/v1/employees/${e.id}/position-history`);
      expect(positions.body).toHaveLength(1);
      expect(positions.body[0].validTo).toBeNull();
      expect(await auditActions(h, w.tenant.id)).toContain("employee.rank_changed");
    });

    it("a transfer changes the position from a date and keeps the rank", async () => {
      const w = await world();
      const e = await w.employee({ rank: "Ахмад", position: "Харуул", startDate: "2020-01-01" });
      const moved = await put(w.hr, `/v1/employees/${e.id}/position`, {
        position: "Ахлах харуул",
        effectiveDate: "2023-01-01",
      });
      expect(moved.body[0]).toMatchObject({
        position: "Ахлах харуул",
        validFrom: "2023-01-01",
        validTo: null,
      });
      expect(moved.body[1]).toMatchObject({ position: "Харуул", validTo: "2023-01-01" });
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(1);
      expect(await auditActions(h, w.tenant.id)).toContain("employee.position_changed");
    });

    it("PATCH applies a different rank or position from today, null removes it, the same one changes nothing", async () => {
      const w = await world();
      const e = await w.employee({ rank: "Ахлагч", startDate: "2020-01-01" });
      expect((await patch(w.hr, `/v1/employees/${e.id}`, { rank: "ахлагч" })).status).toBe(200); // same, ignoring case
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(1);
      const changed = await patch(w.hr, `/v1/employees/${e.id}`, {
        rank: "Менежер",
        position: "Нягтлан",
      });
      expect(changed.body).toMatchObject({ rank: "Менежер", position: "Нягтлан" });
      const history = (await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body;
      expect(history).toHaveLength(2);
      expect(history[0].validFrom).toBe(today());
      expect(history[1].validTo).toBe(today());
      // fixing a typo on the day it was set corrects it in place instead of adding a one-day period
      const fixed = await patch(w.hr, `/v1/employees/${e.id}`, { rank: "Ахлах менежер" });
      expect(fixed.body.rank).toBe("Ахлах менежер");
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(2);
      // null removes the position (here it was set today, so the row disappears)
      const cleared = await patch(w.hr, `/v1/employees/${e.id}`, { position: null });
      expect(cleared.body.position).toBeNull();
      expect((await get(w.hr, `/v1/employees/${e.id}/position-history`)).body).toEqual([]);
      expect((await patch(w.hr, `/v1/employees/${e.id}`, { position: null })).status).toBe(200); // nothing to remove: no-op
      expect((await patch(w.hr, `/v1/employees/${e.id}`, { rank: "" })).status).toBe(400);
    });

    it("an earlier value can be ended without a successor with PUT null", async () => {
      const w = await world();
      const e = await w.employee({ position: "Харуул", startDate: "2020-01-01" });
      const ended = await put(w.hr, `/v1/employees/${e.id}/position`, {
        position: null,
        effectiveDate: "2024-01-01",
      });
      expect(ended.status).toBe(200);
      expect(ended.body).toEqual([
        expect.objectContaining({ position: "Харуул", validTo: "2024-01-01" }),
      ]);
      expect((await get(w.hr, `/v1/employees/${e.id}`)).body.position).toBeNull();
      const again = await put(w.hr, `/v1/employees/${e.id}/position`, { position: null });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("POSITION_NOT_SET");
      // a new value can follow
      expect(
        (
          await put(w.hr, `/v1/employees/${e.id}/position`, {
            position: "Нярав",
            effectiveDate: "2024-02-01",
          })
        ).status,
      ).toBe(200);
    });

    it("rejects a repeated value, bad dates and overlapping periods", async () => {
      const w = await world();
      const e = await w.employee({ rank: "A", startDate: "2020-01-01" });
      const url = `/v1/employees/${e.id}/rank`;
      const unchanged = await put(w.hr, url, { rank: " a ", effectiveDate: "2021-01-01" });
      expect(unchanged.status).toBe(409);
      expect(unchanged.body.code).toBe("RANK_UNCHANGED");
      expect((await put(w.hr, url, { rank: "B", effectiveDate: "2019-01-01" })).body.code).toBe(
        "EFFECTIVE_DATE_BEFORE_START",
      );
      const before = await put(w.hr, url, { rank: "B", effectiveDate: "2019-12-31" });
      expect(before.status).toBe(400);
      expect((await put(w.hr, url, { rank: "B", effectiveDate: "2999-01-01" })).body.code).toBe(
        "EFFECTIVE_DATE_IN_FUTURE",
      );
      expect((await put(w.hr, url, { rank: "B", effectiveDate: "2021-02-30" })).status).toBe(400);
      expect((await put(w.hr, url, {})).status).toBe(400);
      expect((await put(w.hr, url, { rank: "B", bogus: 1 })).status).toBe(400);
      expect((await put(w.hr, url, { rank: 5 })).status).toBe(400);
      await put(w.hr, url, { rank: "B", effectiveDate: "2022-01-01" });
      const earlier = await put(w.hr, url, { rank: "C", effectiveDate: "2021-06-01" });
      expect(earlier.status).toBe(409);
      expect(earlier.body.code).toBe("EFFECTIVE_DATE_NOT_AFTER_CURRENT");
      expect((await put(w.hr, url, { rank: "C", effectiveDate: "2023-01-01" })).status).toBe(200);
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(3);
    });

    it("offers the values already in use as suggestions for the text fields", async () => {
      const w = await world();
      await w.employee({ rank: "Ахлагч", position: "Харуул" });
      await w.employee({ firstName: "Хоёр", rank: "ахлагч", position: "Нярав" });
      await w.employee({ firstName: "Гурав", rank: "Менежер" });
      expect((await get(w.hr, "/v1/employees/job-titles/rank")).body).toEqual([
        "Ахлагч",
        "Менежер",
      ]);
      expect((await get(w.hr, "/v1/employees/job-titles/position")).body).toEqual([
        "Нярав",
        "Харуул",
      ]);
      expect((await get(w.hr, "/v1/employees/job-titles/other")).status).toBe(400);
      expect((await get(w.mgr, "/v1/employees/job-titles/rank")).status).toBe(403);
      // another organization does not see these
      const other = await world();
      expect((await get(other.hr, "/v1/employees/job-titles/rank")).body).toEqual([]);
    });

    it("only Org Admin and HR change them; a Manager reads only inside their scope; archived is read-only", async () => {
      const w = await world();
      const e = await w.employee({ rank: "Ахлагч", startDate: "2020-01-01" });
      expect((await put(w.mgr, `/v1/employees/${e.id}/rank`, { rank: "Б" })).status).toBe(403);
      expect((await put(w.mgr, `/v1/employees/${e.id}/position`, { position: "Б" })).status).toBe(
        403,
      );
      expect((await put(w.admin, `/v1/employees/${e.id}/rank`, { rank: "Б" })).status).toBe(200);
      expect((await get(w.mgr, `/v1/employees/${e.id}/rank-history`)).status).toBe(404); // no scope = sees nothing
      await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
        locationIds: [w.loc],
        departmentIds: [],
      });
      expect((await get(w.mgr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(2);
      expect((await get(w.mgr, `/v1/employees/${e.id}`)).body.rank).toBe("Б");

      await h.owner.query("UPDATE employee SET status = 'ARCHIVED' WHERE id = $1", [e.id]);
      const archived = await put(w.hr, `/v1/employees/${e.id}/rank`, { rank: "В" });
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe("EMPLOYEE_ARCHIVED");
      const foreign = await world();
      expect((await get(foreign.hr, `/v1/employees/${e.id}/rank-history`)).status).toBe(404);
    });

    it("the employee code is the default login name; the password is a one-time random one", async () => {
      const w = await world();
      const e = await w.employee();
      const account = await post(w.hr, `/v1/employees/${e.id}/account`);
      expect(account.status).toBe(201);
      expect(account.body.username).toBe(e.employeeNo);
      expect(account.body.username).toMatch(/^\d{16}$/u);
      expect(account.body.temporaryPassword).not.toContain(e.employeeNo);
      // the new account can sign in with the code and the one-time password
      const login = await h.http().post("/v1/auth/login").send({
        orgCode: w.tenant.code,
        username: e.employeeNo,
        password: account.body.temporaryPassword,
      });
      expect([200, 201]).toContain(login.status);
      // an explicit username is still possible
      const second = await w.employee({ firstName: "Хоёр" });
      expect(
        (await post(w.hr, `/v1/employees/${second.id}/account`, { username: "hoyor.dorj" })).body
          .username,
      ).toBe("hoyor.dorj");
      expect(
        (await post(w.hr, `/v1/employees/${second.id}/account`, { username: "ab" })).status,
      ).toBe(400);
    });
  },
);
