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

describe.skipIf(!hasDb)("rank (цол) and position (албан тушаал) API (PRD 12, 22.1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

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
    const rank = async (name: string, sortOrder?: number) =>
      (await post(admin, "/v1/ranks", { name, ...(sortOrder ? { sortOrder } : {}) })).body
        .id as string;
    const position = async (name: string) =>
      (await post(admin, "/v1/positions", { name })).body.id as string;
    const employee = async (no: string, extra: object = {}) =>
      (
        await post(hr, "/v1/employees", {
          employeeNo: no,
          fullName: `Name ${no}`,
          departmentId: dept,
          primaryLocationId: loc,
          ...extra,
        })
      ).body;
    return { tenant, admin, hr, mgr, mgrUser, dept, loc, rank, position, employee };
  }

  describe("catalogs", () => {
    it("Org Admin manages them; HR and Manager read; ranks keep their seniority order", async () => {
      const w = await world();
      expect((await post(w.hr, "/v1/ranks", { name: "Ахлагч" })).status).toBe(403);
      expect((await post(w.hr, "/v1/positions", { name: "Харуул" })).status).toBe(403);
      expect((await h.http().get("/v1/ranks")).status).toBe(401);

      const captain = await post(w.admin, "/v1/ranks", { name: "Ахмад", sortOrder: 5 });
      expect(captain.status).toBe(201);
      expect(captain.body).toMatchObject({
        name: "Ахмад",
        sortOrder: 5,
        active: true,
        activeHolders: 0,
      });
      await post(w.admin, "/v1/ranks", { name: "Ахлагч", sortOrder: 1 });
      const auto = await post(w.admin, "/v1/ranks", { name: "Хурандаа" });
      expect(auto.body.sortOrder).toBe(6); // next after the highest

      const list = await get(w.mgr, "/v1/ranks");
      expect(list.status).toBe(200);
      expect(list.body.map((r: { name: string }) => r.name)).toEqual([
        "Ахлагч",
        "Ахмад",
        "Хурандаа",
      ]);
      expect(list.body[0].activeHolders).toBeNull(); // managers get no headcounts
      expect((await get(w.hr, "/v1/ranks/not-a-uuid")).status).toBe(400);
      expect((await get(w.hr, "/v1/ranks/00000000-0000-4000-8000-000000000000")).status).toBe(404);

      expect((await get(w.hr, `/v1/ranks?active=false`)).body).toEqual([]);
      expect(await auditActions(h, w.tenant.id)).toContain("rank.created");
    });

    it("keeps names and order numbers unique, and positions are a plain list", async () => {
      const w = await world();
      await w.rank("Ахлагч", 1);
      const name = await post(w.admin, "/v1/ranks", { name: "Ахлагч", sortOrder: 2 });
      expect(name.status).toBe(409);
      expect(name.body.code).toBe("RANK_NAME_TAKEN");
      const order = await post(w.admin, "/v1/ranks", { name: "Дэслэгч", sortOrder: 1 });
      expect(order.status).toBe(409);
      expect(order.body.code).toBe("RANK_ORDER_TAKEN");
      expect((await post(w.admin, "/v1/ranks", { name: "", sortOrder: 3 })).status).toBe(400);
      expect((await post(w.admin, "/v1/ranks", { name: "X", sortOrder: 0 })).status).toBe(400);
      expect((await post(w.admin, "/v1/ranks", { name: "X", extra: 1 })).status).toBe(400);

      await w.position("Харуул");
      const dup = await post(w.admin, "/v1/positions", { name: "Харуул" });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("POSITION_NAME_TAKEN");
      // positions have no sort order
      expect((await post(w.admin, "/v1/positions", { name: "Нярав", sortOrder: 1 })).status).toBe(
        400,
      );
    });

    it("renames and deactivates; an inactive entry cannot be newly assigned but history stays", async () => {
      const w = await world();
      const rank = await w.rank("Ахлагч", 1);
      const other = await w.rank("Дэслэгч", 2);
      const e = await w.employee("E-1", { rankId: rank });
      const renamed = await patch(w.admin, `/v1/ranks/${rank}`, { name: "Ахлагч (ахлах)" });
      expect(renamed.body.name).toBe("Ахлагч (ахлах)");
      expect(renamed.body.activeHolders).toBe(1);
      expect((await patch(w.admin, `/v1/ranks/${rank}`, {})).status).toBe(400);
      expect((await patch(w.admin, `/v1/ranks/${other}`, { active: false })).body.active).toBe(
        false,
      );
      const refused = await put(w.hr, `/v1/employees/${e.id}/rank`, { rankId: other });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("RANK_INACTIVE");
      // the employee keeps the rank they hold even if it is later deactivated
      await patch(w.admin, `/v1/ranks/${rank}`, { active: false });
      expect((await get(w.hr, `/v1/employees/${e.id}`)).body.rankId).toBe(rank);
      expect((await get(w.hr, "/v1/ranks?active=true")).body).toEqual([]);
    });
  });

  describe("on employees", () => {
    it("creating an employee with a rank and position starts both histories; they show on the record and list", async () => {
      const w = await world();
      const captain = await w.rank("Ахмад", 5);
      const guard = await w.position("Харуул");
      const e = await w.employee("E-1", {
        rankId: captain,
        positionId: guard,
        startDate: "2024-03-01",
      });
      expect(e).toMatchObject({
        rankId: captain,
        rankName: "Ахмад",
        positionId: guard,
        positionName: "Харуул",
      });
      const ranks = await get(w.hr, `/v1/employees/${e.id}/rank-history`);
      expect(ranks.body).toEqual([
        expect.objectContaining({ rankId: captain, validFrom: "2024-03-01", validTo: null }),
      ]);
      const none = await w.employee("E-2");
      expect(none.rankId).toBeNull();
      expect(none.positionName).toBeNull();
      expect((await get(w.hr, `/v1/employees/${none.id}/position-history`)).body).toEqual([]);

      const list = await get(w.hr, "/v1/employees?sort=employeeNo");
      expect(list.body.items[0]).toMatchObject({
        employeeNo: "E-1",
        rankName: "Ахмад",
        positionName: "Харуул",
      });
      expect((await get(w.hr, `/v1/employees?rankId=${captain}`)).body.total).toBe(1);
      expect((await get(w.hr, `/v1/employees?positionId=${guard}`)).body.items).toHaveLength(1);
      const unknownRank = await post(w.hr, "/v1/employees", {
        employeeNo: "E-3",
        fullName: "X",
        departmentId: w.dept,
        primaryLocationId: w.loc,
        rankId: "00000000-0000-4000-8000-000000000000",
      });
      expect(unknownRank.status).toBe(400);
      expect(unknownRank.body.code).toBe("RANK_NOT_FOUND");
      // the failed create left nothing behind
      expect((await get(w.hr, "/v1/employees?q=E-3")).body.total).toBe(0);
    });

    it("a promotion ends the open rank period and leaves the position history alone", async () => {
      const w = await world();
      const [lieutenant, captain] = [await w.rank("Дэслэгч", 3), await w.rank("Ахмад", 5)];
      const guard = await w.position("Харуул");
      const e = await w.employee("E-1", {
        rankId: lieutenant,
        positionId: guard,
        startDate: "2020-01-01",
      });
      const promoted = await put(w.hr, `/v1/employees/${e.id}/rank`, {
        rankId: captain,
        effectiveDate: "2022-06-01",
        note: "Тушаал №12",
      });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toEqual([
        expect.objectContaining({
          rankId: captain,
          validFrom: "2022-06-01",
          validTo: null,
          note: "Тушаал №12",
        }),
        expect.objectContaining({
          rankId: lieutenant,
          validFrom: "2020-01-01",
          validTo: "2022-06-01",
        }),
      ]);
      const record = (await get(w.hr, `/v1/employees/${e.id}`)).body;
      expect(record.rankName).toBe("Ахмад");
      expect(record.positionName).toBe("Харуул");
      const positions = await get(w.hr, `/v1/employees/${e.id}/position-history`);
      expect(positions.body).toHaveLength(1);
      expect(positions.body[0].validTo).toBeNull();
      expect(await auditActions(h, w.tenant.id)).toContain("employee.rank_changed");
    });

    it("a transfer changes the position from a date and keeps the rank", async () => {
      const w = await world();
      const rank = await w.rank("Ахмад", 5);
      const [guard, chief] = [await w.position("Харуул"), await w.position("Ахлах харуул")];
      const e = await w.employee("E-1", {
        rankId: rank,
        positionId: guard,
        startDate: "2020-01-01",
      });
      const moved = await put(w.hr, `/v1/employees/${e.id}/position`, {
        positionId: chief,
        effectiveDate: "2023-01-01",
      });
      expect(moved.status).toBe(200);
      expect(moved.body[0]).toMatchObject({
        positionId: chief,
        validFrom: "2023-01-01",
        validTo: null,
      });
      expect(moved.body[1]).toMatchObject({ positionId: guard, validTo: "2023-01-01" });
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(1);
      expect(await auditActions(h, w.tenant.id)).toContain("employee.position_changed");
    });

    it("PATCH with a different rank or position applies from today; the same one changes nothing", async () => {
      const w = await world();
      const [a, b] = [await w.rank("Ахлагч", 1), await w.rank("Дэслэгч", 3)];
      const e = await w.employee("E-1", { rankId: a, startDate: "2020-01-01" });
      const same = await patch(w.hr, `/v1/employees/${e.id}`, { rankId: a });
      expect(same.status).toBe(200);
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(1);
      const changed = await patch(w.hr, `/v1/employees/${e.id}`, { rankId: b });
      expect(changed.body.rankName).toBe("Дэслэгч");
      const history = (await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body;
      expect(history).toHaveLength(2);
      expect(history[0].validFrom).toBe(todayIn("Asia/Ulaanbaatar", h.clock.now()));
      expect(history[1].validTo).toBe(history[0].validFrom);
    });

    it("rejects a repeated rank, bad dates and overlapping periods", async () => {
      const w = await world();
      const [a, b, c] = [
        await w.rank("Ахлагч", 1),
        await w.rank("Дэслэгч", 3),
        await w.rank("Ахмад", 5),
      ];
      const e = await w.employee("E-1", { rankId: a, startDate: "2020-01-01" });
      const url = `/v1/employees/${e.id}/rank`;
      const unchanged = await put(w.hr, url, { rankId: a, effectiveDate: "2021-01-01" });
      expect(unchanged.status).toBe(409);
      expect(unchanged.body.code).toBe("RANK_UNCHANGED");
      const before = await put(w.hr, url, { rankId: b, effectiveDate: "2019-01-01" });
      expect(before.status).toBe(400);
      expect(before.body.code).toBe("EFFECTIVE_DATE_BEFORE_START");
      const sameDay = await put(w.hr, url, { rankId: b, effectiveDate: "2020-01-01" });
      expect(sameDay.status).toBe(409);
      expect(sameDay.body.code).toBe("EFFECTIVE_DATE_NOT_AFTER_CURRENT");
      expect(sameDay.body.currentFrom).toBe("2020-01-01");
      const future = await put(w.hr, url, { rankId: b, effectiveDate: "2999-01-01" });
      expect(future.status).toBe(400);
      expect(future.body.code).toBe("EFFECTIVE_DATE_IN_FUTURE");
      expect((await put(w.hr, url, { rankId: b, effectiveDate: "2021-02-30" })).status).toBe(400);
      expect((await put(w.hr, url, {})).status).toBe(400);
      expect((await put(w.hr, url, { rankId: b, bogus: 1 })).status).toBe(400);
      // back-dating before the latest period began is refused, a valid promotion still works afterwards
      await put(w.hr, url, { rankId: b, effectiveDate: "2022-01-01" });
      const earlier = await put(w.hr, url, { rankId: c, effectiveDate: "2021-06-01" });
      expect(earlier.status).toBe(409);
      expect((await put(w.hr, url, { rankId: c, effectiveDate: "2023-01-01" })).status).toBe(200);
      expect((await get(w.hr, `/v1/employees/${e.id}/rank-history`)).body).toHaveLength(3);
    });
  });

  describe("permissions and data scope", () => {
    it("only Org Admin and HR change them; a Manager reads only inside their scope", async () => {
      const w = await world();
      const rank = await w.rank("Ахлагч", 1);
      const e = await w.employee("E-1", { rankId: rank, startDate: "2020-01-01" });
      const other = await w.rank("Дэслэгч", 3);
      expect((await put(w.mgr, `/v1/employees/${e.id}/rank`, { rankId: other })).status).toBe(403);
      expect(
        (await put(w.mgr, `/v1/employees/${e.id}/position`, { positionId: other })).status,
      ).toBe(403);
      expect((await put(w.admin, `/v1/employees/${e.id}/rank`, { rankId: other })).status).toBe(
        200,
      );
      // no scope assigned = sees nothing, so the history looks like a missing employee
      const hidden = await get(w.mgr, `/v1/employees/${e.id}/rank-history`);
      expect(hidden.status).toBe(404);
      await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
        locationIds: [w.loc],
        departmentIds: [],
      });
      const visible = await get(w.mgr, `/v1/employees/${e.id}/rank-history`);
      expect(visible.status).toBe(200);
      expect(visible.body).toHaveLength(2);
    });

    it("archived employees are read-only and another tenant's rank cannot be used", async () => {
      const w = await world();
      const rank = await w.rank("Ахлагч", 1);
      const e = await w.employee("E-1");
      const foreign = await world();
      const foreignRank = await foreign.rank("Ахлагч", 1);
      const cross = await put(w.hr, `/v1/employees/${e.id}/rank`, { rankId: foreignRank });
      expect(cross.status).toBe(400);
      expect(cross.body.code).toBe("RANK_NOT_FOUND");
      expect((await get(foreign.hr, `/v1/employees/${e.id}/rank-history`)).status).toBe(404);

      await h.owner.query("UPDATE employee SET status = 'ARCHIVED' WHERE id = $1", [e.id]);
      const archived = await put(w.hr, `/v1/employees/${e.id}/rank`, { rankId: rank });
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe("EMPLOYEE_ARCHIVED");
    });
  });
});
