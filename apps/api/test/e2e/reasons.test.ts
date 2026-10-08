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

describe.skipIf(!hasDb)("reasons and reason assignments (PRD 11)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const today = () => todayIn("Asia/Ulaanbaatar", h.clock.now());
  const addDays = (date: string, n: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  /** The system assigns 16-digit codes; tests relabel them (E-1, E-2 ...) so they stay readable and sortable. */
  const relabel = async (res: { body: { id: string } }, no: string): Promise<string> => {
    await h.owner.query("UPDATE employee SET employee_no = $1 WHERE id = $2", [no, res.body.id]);
    return res.body.id;
  };
  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);
  const put = (token: string, url: string, body: object) =>
    h.http().put(url).set(bearer(token)).send(body);
  const patch = (token: string, url: string, body: object) =>
    h.http().patch(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));
  const del = (token: string, url: string) => h.http().delete(url).set(bearer(token));

  async function world() {
    const tenant = await createTenant(h);
    // the 16 predefined reasons (PRD 11), as a new tenant gets them
    await h.owner.query("SELECT seed_default_reasons($1)", [tenant.id]);
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
    const dept2 = (await post(admin, "/v1/departments", { name: "Санхүү" })).body.id as string;
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    const central = await loc("Төв салбар");
    const emma = await loc("ЭМАА");
    const employee = async (no: string, location = central, department = dept) =>
      relabel(
        await post(hr, "/v1/employees", {
          lastName: "Name",
          firstName: no,
          departmentId: department,
          primaryLocationId: location,
        }),
        no,
      );
    const reasonId = async (name: string) =>
      ((await get(admin, "/v1/reasons")).body as Array<{ id: string; name: string }>).find(
        (r) => r.name === name,
      )!.id;
    return { tenant, admin, hr, mgr, mgrUser, dept, dept2, central, emma, employee, reasonId };
  }

  describe("the list of reasons", () => {
    it("a tenant starts with the 16 predefined reasons in their order; Org Admin manages them", async () => {
      const w = await world();
      const list = await get(w.hr, "/v1/reasons");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(16);
      expect(list.body[0]).toMatchObject({
        name: "Албан ажилтай",
        sortOrder: 1,
        active: true,
        assignments: 0,
      });
      expect(list.body[14].name).toBe("Тасалсан");
      // «Бусад» comes last and must be explained in words
      expect(list.body[15]).toMatchObject({ name: "Бусад", requiresDescription: true });
      expect(list.body[0].requiresDescription).toBe(false);
      expect((await get(w.mgr, "/v1/reasons")).body[0].assignments).toBeNull();
      // repeating the seed changes nothing
      await h.owner.query("SELECT seed_default_reasons($1)", [w.tenant.id]);
      expect((await get(w.hr, "/v1/reasons")).body).toHaveLength(16);

      expect((await post(w.hr, "/v1/reasons", { name: "Шинэ" })).status).toBe(403);
      const created = await post(w.admin, "/v1/reasons", { name: "Гадаад томилолт" });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ sortOrder: 17, active: true });
      const dup = await post(w.admin, "/v1/reasons", { name: "Гадаад томилолт" });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("REASON_NAME_TAKEN");
      expect((await post(w.admin, "/v1/reasons", { name: "", sortOrder: 1 })).status).toBe(400);
      expect(
        (await patch(w.admin, `/v1/reasons/${created.body.id}`, { name: "Гадаад ажил" })).body.name,
      ).toBe("Гадаад ажил");
      expect((await patch(w.admin, `/v1/reasons/${created.body.id}`, {})).status).toBe(400);
      expect((await get(w.hr, `/v1/reasons?active=false`)).body).toEqual([]);
      expect((await get(w.hr, "/v1/reasons/not-a-uuid")).status).toBe(400);
      expect((await get(w.hr, "/v1/reasons/00000000-0000-4000-8000-000000000000")).status).toBe(
        404,
      );
      expect(await auditActions(h, w.tenant.id)).toEqual(
        expect.arrayContaining(["reason.created", "reason.updated"]),
      );
    });

    it("an unused reason can be deleted; one that was assigned is only deactivated", async () => {
      const w = await world();
      const fresh = (await post(w.admin, "/v1/reasons", { name: "Түр" })).body.id as string;
      expect((await del(w.admin, `/v1/reasons/${fresh}`)).status).toBe(204);
      expect((await del(w.admin, `/v1/reasons/${fresh}`)).status).toBe(404);

      const emp = await w.employee("E-1");
      const sick = await w.reasonId("Өвчтэй");
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [emp],
        reasonId: sick,
        fromDate: today(),
      });
      const inUse = await del(w.admin, `/v1/reasons/${sick}`);
      expect(inUse.status).toBe(409);
      expect(inUse.body.code).toBe("REASON_IN_USE");
      expect((await patch(w.admin, `/v1/reasons/${sick}`, { active: false })).body.active).toBe(
        false,
      );
      const refused = await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [await w.employee("E-2")],
        reasonId: sick,
        fromDate: today(),
      });
      expect(refused.body.code).toBe("REASON_INACTIVE");
      expect(await auditActions(h, w.tenant.id)).toContain("reason.deleted");
    });
  });

  describe("assignments", () => {
    it("«Бусад» (Other) must be explained in words; other reasons need no description", async () => {
      const w = await world();
      const emp = await w.employee("E-1");
      const other = await w.reasonId("Бусад");
      const base = { employeeIds: [emp], reasonId: other, fromDate: today() };
      for (const description of [undefined, "", "  ", "ab"]) {
        const res = await post(w.hr, "/v1/reason-assignments", { ...base, description });
        expect(res.status, String(description)).toBe(400);
        expect(res.body.code).toBe("DESCRIPTION_REQUIRED");
      }
      const ok = await post(w.hr, "/v1/reason-assignments", {
        ...base,
        description: "Хурлын өрөөнд ажилласан",
      });
      expect(ok.status).toBe(201);
      const sick = await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [await w.employee("E-2")],
        reasonId: await w.reasonId("Өвчтэй"),
        fromDate: today(),
      });
      expect(sick.status).toBe(201);
    });

    it("HR gives one reason to many employees for a date range, with a description", async () => {
      const w = await world();
      const [a, b] = [await w.employee("E-1"), await w.employee("E-2")];
      const training = await w.reasonId("Сургалттай");
      expect(
        (
          await post(w.mgr, "/v1/reason-assignments", {
            employeeIds: [a],
            reasonId: training,
            fromDate: today(),
          })
        ).status,
      ).toBe(403);
      const res = await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [a, b],
        reasonId: training,
        fromDate: "2026-10-06",
        toDate: "2026-11-10",
        description: "Аюулгүй ажиллагааны сургалт",
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(2);
      const list = await get(w.hr, `/v1/reason-assignments?employeeId=${a}`);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({
        employeeNo: "E-1",
        reasonName: "Сургалттай",
        fromDate: "2026-10-06",
        toDate: "2026-11-10",
        description: "Аюулгүй ажиллагааны сургалт",
        endedAt: null,
      });
      // "which employees have a reason on this date" (what the daily list needs)
      expect((await get(w.hr, "/v1/reason-assignments?activeOn=2026-10-20")).body.total).toBe(2);
      expect((await get(w.hr, "/v1/reason-assignments?activeOn=2026-11-11")).body.total).toBe(0);
      expect((await get(w.hr, "/v1/reason-assignments?activeOn=2026-10-05")).body.total).toBe(0);
      expect(
        (await get(w.hr, "/v1/reason-assignments?from=2026-11-10&to=2026-11-12")).body.total,
      ).toBe(2);
      expect(
        (await get(w.hr, `/v1/reason-assignments?reasonId=${training}&limit=1`)).body.items,
      ).toHaveLength(1);
      expect(await auditActions(h, w.tenant.id)).toContain("reason_assignment.created");
    });

    it("an employee has one reason at a time; a clash names the existing assignment and nothing is saved", async () => {
      const w = await world();
      const [a, b] = [await w.employee("E-1"), await w.employee("E-2")];
      const sick = await w.reasonId("Өвчтэй");
      const leave = await w.reasonId("Чөлөөтэй");
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [a],
        reasonId: sick,
        fromDate: "2026-10-10",
        toDate: "2026-10-14",
      });
      const clash = await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [b, a],
        reasonId: leave,
        fromDate: "2026-10-14",
        toDate: "2026-10-16",
      });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe("REASON_OVERLAP");
      expect(clash.body.conflicts).toEqual([
        expect.objectContaining({
          employeeId: a,
          reasonName: "Өвчтэй",
          fromDate: "2026-10-10",
          toDate: "2026-10-14",
        }),
      ]);
      expect((await get(w.hr, `/v1/reason-assignments?employeeId=${b}`)).body.total).toBe(0);
      // the next day is free, and so is the one before
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            employeeIds: [a],
            reasonId: leave,
            fromDate: "2026-10-15",
            toDate: "2026-10-16",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            employeeIds: [a],
            reasonId: leave,
            fromDate: "2026-10-01",
            toDate: "2026-10-09",
          })
        ).status,
      ).toBe(201);
      // an open-ended reason blocks everything after its start
      const open = await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [b],
        reasonId: leave,
        fromDate: "2026-10-01",
      });
      expect(open.status).toBe(201);
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            employeeIds: [b],
            reasonId: sick,
            fromDate: "2030-01-01",
            toDate: "2030-01-02",
          })
        ).body.code,
      ).toBe("REASON_OVERLAP");
    });

    it("validates the request, the reason and the employees", async () => {
      const w = await world();
      const emp = await w.employee("E-1");
      const reason = await w.reasonId("Өвчтэй");
      const ok = { employeeIds: [emp], reasonId: reason, fromDate: today() };
      expect(
        (await post(w.hr, "/v1/reason-assignments", { ...ok, toDate: addDays(today(), -1) }))
          .status,
      ).toBe(400);
      expect(
        (await post(w.hr, "/v1/reason-assignments", { ...ok, fromDate: "2026-02-30" })).status,
      ).toBe(400);
      expect((await post(w.hr, "/v1/reason-assignments", { ...ok, employeeIds: [] })).status).toBe(
        400,
      );
      expect(
        (await post(w.hr, "/v1/reason-assignments", { ...ok, employeeIds: [emp, emp] })).status,
      ).toBe(400);
      expect((await post(w.hr, "/v1/reason-assignments", { ...ok, bogus: 1 })).status).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            ...ok,
            reasonId: "00000000-0000-4000-8000-000000000000",
          })
        ).body.code,
      ).toBe("REASON_NOT_FOUND");
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            ...ok,
            employeeIds: [emp, "00000000-0000-4000-8000-000000000000"],
          })
        ).status,
      ).toBe(404);
      // a past date is allowed: HR explains a day that was already Ирээгүй
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            ...ok,
            fromDate: addDays(today(), -3),
            toDate: addDays(today(), -3),
          })
        ).status,
      ).toBe(201);
      const gone = await w.employee("E-2");
      await post(w.hr, `/v1/employees/${gone}/disable`, {});
      const inactive = await post(w.hr, "/v1/reason-assignments", { ...ok, employeeIds: [gone] });
      expect(inactive.body.code).toBe("EMPLOYEE_NOT_ACTIVE");
      expect(inactive.body.employeeIds).toEqual([gone]);
    });

    it("ending a reason early keeps it as history; an unstarted one can be deleted", async () => {
      const w = await world();
      const emp = await w.employee("E-1");
      const reason = await w.reasonId("Өвчтэй");
      const from = addDays(today(), -2);
      const id = (
        await post(w.hr, "/v1/reason-assignments", {
          employeeIds: [emp],
          reasonId: reason,
          fromDate: from,
          toDate: addDays(today(), 10),
        })
      ).body.assignmentIds[0] as string;
      expect(
        (await post(w.hr, `/v1/reason-assignments/${id}/end`, { endDate: addDays(from, -1) }))
          .status,
      ).toBe(400);
      expect(
        (await post(w.hr, `/v1/reason-assignments/${id}/end`, { endDate: addDays(today(), 10) }))
          .status,
      ).toBe(400);
      const ended = await post(w.hr, `/v1/reason-assignments/${id}/end`, { endDate: today() });
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ fromDate: from, toDate: today() });
      expect(ended.body.endedAt).not.toBeNull();
      // the freed days can get another reason
      expect(
        (
          await post(w.hr, "/v1/reason-assignments", {
            employeeIds: [emp],
            reasonId: reason,
            fromDate: addDays(today(), 1),
            toDate: addDays(today(), 2),
          })
        ).status,
      ).toBe(201);
      // started: cannot be deleted
      expect((await del(w.hr, `/v1/reason-assignments/${id}`)).body.code).toBe("REASON_STARTED");
      // an open-ended one can be closed
      const open = (
        await post(w.hr, "/v1/reason-assignments", {
          employeeIds: [emp],
          reasonId: reason,
          fromDate: addDays(today(), 20),
        })
      ).body.assignmentIds[0] as string;
      expect(
        (await post(w.hr, `/v1/reason-assignments/${open}/end`, { endDate: addDays(today(), 25) }))
          .body.toDate,
      ).toBe(addDays(today(), 25));
      // unstarted: delete
      expect((await del(w.hr, `/v1/reason-assignments/${open}`)).status).toBe(204);
      expect((await del(w.hr, `/v1/reason-assignments/${open}`)).status).toBe(404);
      expect(await auditActions(h, w.tenant.id)).toEqual(
        expect.arrayContaining(["reason_assignment.ended", "reason_assignment.deleted"]),
      );
    });

    it("disabling an employee ends their open reasons and removes later ones (PRD 12.2)", async () => {
      const w = await world();
      const emp = await w.employee("E-1");
      const reason = await w.reasonId("Чөлөөтэй");
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [emp],
        reasonId: reason,
        fromDate: addDays(today(), -5),
        toDate: addDays(today(), 5),
      });
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [emp],
        reasonId: reason,
        fromDate: addDays(today(), 10),
        toDate: addDays(today(), 12),
      });
      const res = await post(w.hr, `/v1/employees/${emp}/disable`, {});
      expect(res.body).toMatchObject({ reasonAssignmentsEnded: 1, reasonAssignmentsRemoved: 1 });
      const left = await get(w.hr, `/v1/reason-assignments?employeeId=${emp}`);
      expect(left.body.items).toHaveLength(1);
      expect(left.body.items[0].toDate).toBe(today());
    });

    it("a Manager reads only reasons of employees in their scope; HR sees all unless scoped", async () => {
      const w = await world();
      const [inCentral, inEmma] = [
        await w.employee("E-1", w.central),
        await w.employee("E-2", w.emma),
      ];
      const reason = await w.reasonId("Өвчтэй");
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [inCentral, inEmma],
        reasonId: reason,
        fromDate: today(),
      });
      expect((await get(w.mgr, "/v1/reason-assignments")).body.total).toBe(0);
      await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
        locationIds: [w.emma],
        departmentIds: [],
      });
      const seen = await get(w.mgr, "/v1/reason-assignments");
      expect(seen.body.items.map((x: { employeeNo: string }) => x.employeeNo)).toEqual(["E-2"]);
      expect(
        (await get(w.mgr, "/v1/reason-report?from=2026-01-01&to=2026-12-31")).body.items.find(
          (r: { reasonName: string }) => r.reasonName === "Өвчтэй",
        ).employees,
      ).toBe(1);
    });
  });

  describe("reason report (PRD 11.1)", () => {
    it("counts distinct employees and employee-days per reason inside the period, with filters", async () => {
      const w = await world();
      const [a, b, c] = [
        await w.employee("E-1", w.central, w.dept),
        await w.employee("E-2", w.central, w.dept2),
        await w.employee("E-3", w.emma, w.dept),
      ];
      const training = await w.reasonId("Сургалттай");
      const sick = await w.reasonId("Өвчтэй");
      // a: 10 days of training (Oct 6–15), then 2 days sick; b and c: training Oct 14–20
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [a],
        reasonId: training,
        fromDate: "2026-10-06",
        toDate: "2026-10-15",
      });
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [a],
        reasonId: sick,
        fromDate: "2026-10-16",
        toDate: "2026-10-17",
      });
      await post(w.hr, "/v1/reason-assignments", {
        employeeIds: [b, c],
        reasonId: training,
        fromDate: "2026-10-14",
        toDate: "2026-10-20",
      });
      const row = (body: { items: Array<{ reasonName: string }> }, name: string) =>
        body.items.find((r) => r.reasonName === name);

      const all = (await get(w.hr, "/v1/reason-report?from=2026-10-01&to=2026-10-31")).body;
      expect(row(all, "Сургалттай")).toMatchObject({ employees: 3, employeeDays: 10 + 7 + 7 });
      expect(row(all, "Өвчтэй")).toMatchObject({ employees: 1, employeeDays: 2 });
      expect(row(all, "Тасалсан")).toMatchObject({ employees: 0, employeeDays: 0 });
      expect(all.items).toHaveLength(16);
      // the period clips the days: Oct 14–16 only
      const clipped = (await get(w.hr, "/v1/reason-report?from=2026-10-14&to=2026-10-16")).body;
      expect(row(clipped, "Сургалттай")).toMatchObject({ employees: 3, employeeDays: 2 + 3 + 3 });
      expect(row(clipped, "Өвчтэй")).toMatchObject({ employees: 1, employeeDays: 1 });
      expect(
        row(
          (await get(w.hr, "/v1/reason-report?from=2026-11-01&to=2026-11-30")).body,
          "Сургалттай",
        ),
      ).toMatchObject({ employees: 0, employeeDays: 0 });
      // filters
      expect(
        row(
          (await get(w.hr, `/v1/reason-report?from=2026-10-01&to=2026-10-31&locationId=${w.emma}`))
            .body,
          "Сургалттай",
        ),
      ).toMatchObject({ employees: 1, employeeDays: 7 });
      expect(
        row(
          (
            await get(
              w.hr,
              `/v1/reason-report?from=2026-10-01&to=2026-10-31&departmentId=${w.dept2}`,
            )
          ).body,
          "Сургалттай",
        ),
      ).toMatchObject({ employees: 1, employeeDays: 7 });
      // drill-down: who had it, with dates and description
      const drill = await get(
        w.hr,
        `/v1/reason-assignments?reasonId=${training}&from=2026-10-01&to=2026-10-31`,
      );
      expect(drill.body.total).toBe(3);
      // a retired reason that was used stays in the report; an unused retired one does not
      await patch(w.admin, `/v1/reasons/${training}`, { active: false });
      await patch(w.admin, `/v1/reasons/${await w.reasonId("Тасалсан")}`, { active: false });
      const after = (await get(w.hr, "/v1/reason-report?from=2026-10-01&to=2026-10-31")).body;
      expect(row(after, "Сургалттай")).toBeDefined();
      expect(row(after, "Тасалсан")).toBeUndefined();
      // bad periods
      expect((await get(w.hr, "/v1/reason-report?from=2026-10-31&to=2026-10-01")).status).toBe(400);
      expect((await get(w.hr, "/v1/reason-report?from=2020-01-01&to=2026-10-01")).status).toBe(400);
      expect((await get(w.hr, "/v1/reason-report")).status).toBe(400);
    });
  });
});
