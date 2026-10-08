import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayIn } from "../../src/common/dates";
import { hasDb } from "../db/helpers";
import { bearer, createTenant, createUser, type Harness, signIn, startHarness } from "./harness";

describe.skipIf(!hasDb)("roster calendar (PRD 23.5)", () => {
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
  const isoWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);
  const put = (token: string, url: string, body: object) =>
    h.http().put(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));

  async function world(opts: { week?: boolean } = {}) {
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
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    const central = await loc("Төв салбар");
    const emma = await loc("ЭМАА");
    if (opts.week !== false) {
      await put(admin, "/v1/working-week", {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
          weekday <= 5
            ? { weekday, working: true, start: "08:30", end: "17:30" }
            : { weekday, working: false },
        ),
      });
    }
    const employee = async (
      no: string,
      scheduleMode: "STANDARD" | "SHIFT",
      location = central,
      extra: object = {},
    ) =>
      (
        await post(hr, "/v1/employees", {
          employeeNo: no,
          fullName: `Name ${no}`,
          departmentId: dept,
          primaryLocationId: location,
          scheduleMode,
          ...extra,
        })
      ).body.id as string;
    return { tenant, admin, hr, mgr, mgrUser, dept, central, emma, employee };
  }

  const range = (days: number) => `from=${today()}&to=${addDays(today(), days - 1)}`;
  type Cell = Record<string, unknown> & { date: string };
  const cellsOf = (body: { items: Array<{ cells: Cell[] }> }, index = 0) =>
    body.items[index]!.cells;

  it("a standard employee follows the working week, holidays and working-day exceptions", async () => {
    const w = await world();
    await w.employee("S-1", "STANDARD");
    const holiday = addDays(today(), 3);
    await post(w.admin, "/v1/holidays", { name: "Баяр", fromDate: holiday, toDate: holiday });
    // the first Saturday in the window becomes a working day with its own hours
    const saturday = Array.from({ length: 7 }, (_, i) => addDays(today(), i)).find(
      (d) => isoWeekday(d) === 6,
    )!;
    await post(w.admin, "/v1/working-day-exceptions", {
      date: saturday,
      working: true,
      start: "09:00",
      end: "13:00",
    });

    const res = await get(w.hr, `/v1/shift-roster?${range(7)}`);
    expect(res.status).toBe(200);
    expect(res.body.dates).toHaveLength(7);
    expect(res.body.total).toBe(1);
    const cells = cellsOf(res.body);
    for (const c of cells) {
      if (c.date === holiday) expect(c).toMatchObject({ expected: false, reason: "HOLIDAY" });
      else if (c.date === saturday)
        expect(c).toMatchObject({
          expected: true,
          source: "STANDARD",
          start: "09:00",
          end: "13:00",
        });
      else if (isoWeekday(c.date) <= 5)
        expect(c).toMatchObject({
          expected: true,
          start: "08:30",
          end: "17:30",
          endsNextDay: false,
        });
      else expect(c).toMatchObject({ expected: false, reason: "OFF_DAY" });
    }
  });

  it("a 24/48 guard works every third day, holidays do not stop a 24 h shift, overrides show", async () => {
    const w = await world();
    const guard = (
      await post(w.admin, "/v1/shift-templates", {
        name: "24 цаг",
        startTime: "08:00",
        endTime: "08:00",
      })
    ).body.id as string;
    const pattern = (
      await post(w.admin, "/v1/shift-patterns", { name: "24/48", days: [guard, null, null] })
    ).body.id as string;
    const emp = await w.employee("G-1", "SHIFT");
    await post(w.hr, "/v1/shift-assignments", {
      items: [{ employeeId: emp }],
      patternId: pattern,
      fromDate: today(),
    });
    await post(w.admin, "/v1/holidays", {
      name: "Баяр",
      fromDate: today(),
      toDate: today(),
      confirmRecompute: true,
    });
    const extra = (
      await post(w.admin, "/v1/shift-templates", {
        name: "Өдөр",
        startTime: "08:00",
        endTime: "20:00",
      })
    ).body.id as string;
    await post(w.hr, "/v1/shift-overrides", {
      employeeId: emp,
      workDate: addDays(today(), 1),
      kind: "ADD",
      templateId: extra,
      reason: "Нэмэлт",
    });
    await post(w.hr, "/v1/shift-overrides", {
      employeeId: emp,
      workDate: addDays(today(), 3),
      kind: "REMOVE",
    });

    const res = await get(w.hr, `/v1/shift-roster?${range(7)}&scheduleMode=SHIFT`);
    const c = cellsOf(res.body);
    // day 0: on duty although it is a public holiday (the template does not observe holidays), 24 h
    expect(c[0]).toMatchObject({
      expected: true,
      source: "SHIFT",
      shiftTemplateId: guard,
      start: "08:00",
      end: "08:00",
      endsNextDay: true,
    });
    expect(c[1]).toMatchObject({
      expected: true,
      shiftTemplateId: extra,
      start: "08:00",
      end: "20:00",
      endsNextDay: false,
      override: "ADD",
    });
    expect(c[2]).toMatchObject({ expected: false, reason: "SHIFT_OFF" });
    expect(c[3]).toMatchObject({ expected: false, reason: "SHIFT_OFF", override: "REMOVE" }); // would have been day 3 = duty
    expect(c[4]).toMatchObject({ expected: false, reason: "SHIFT_OFF" });
    expect(c[5]).toMatchObject({ expected: false, reason: "SHIFT_OFF" });
    expect(c[6]).toMatchObject({ expected: true, shiftTemplateId: guard });
    expect(res.body.templates.map((t: { name: string }) => t.name).sort()).toEqual([
      "24 цаг",
      "Өдөр",
    ]);
  });

  it("a night shift shows its start and end on the work date it starts; a staggered team is offset", async () => {
    const w = await world();
    const night = (
      await post(w.admin, "/v1/shift-templates", {
        name: "Шөнө",
        startTime: "20:00",
        endTime: "08:00",
      })
    ).body.id as string;
    const pattern = (
      await post(w.admin, "/v1/shift-patterns", { name: "Шөнө/амралт", days: [night, null] })
    ).body.id as string;
    const [a, b] = [await w.employee("N-1", "SHIFT"), await w.employee("N-2", "SHIFT")];
    await post(w.hr, "/v1/shift-assignments", {
      patternId: pattern,
      fromDate: today(),
      items: [{ employeeId: a }, { employeeId: b, cycleStartDate: addDays(today(), 1) }],
    });
    const res = await get(w.hr, `/v1/shift-roster?${range(4)}`);
    const [ca, cb] = [cellsOf(res.body, 0), cellsOf(res.body, 1)];
    expect(ca[0]).toMatchObject({
      expected: true,
      start: "20:00",
      end: "08:00",
      endsNextDay: true,
    });
    expect(ca.map((x) => x.expected)).toEqual([true, false, true, false]);
    expect(cb.map((x) => x.expected)).toEqual([false, true, false, true]);
  });

  it("flags a planned duty that collides with a reason, and shows a reason on a day off without a flag", async () => {
    const w = await world();
    const day = (
      await post(w.admin, "/v1/shift-templates", {
        name: "Өдөр",
        startTime: "08:00",
        endTime: "20:00",
      })
    ).body.id as string;
    const emp = await w.employee("R-1", "SHIFT");
    await post(w.hr, "/v1/shift-assignments", {
      items: [{ employeeId: emp }],
      templateId: day,
      fromDate: today(),
    });
    const sick = (await get(w.admin, "/v1/reasons")).body as Array<{ name: string }>;
    expect(sick).toEqual([]); // no predefined reasons in this tenant: create one
    const reason = (await post(w.admin, "/v1/reasons", { name: "Өвчтэй" })).body.id as string;
    await post(w.hr, "/v1/reason-assignments", {
      employeeIds: [emp],
      reasonId: reason,
      fromDate: addDays(today(), 1),
      toDate: addDays(today(), 2),
    });
    const res = await get(w.hr, `/v1/shift-roster?${range(4)}`);
    const c = cellsOf(res.body);
    expect(c[0]).toMatchObject({ conflict: false, absenceReason: null });
    expect(c[1]).toMatchObject({ expected: true, absenceReason: "Өвчтэй", conflict: true });
    expect(c[2]).toMatchObject({ conflict: true });
    expect(c[3]).toMatchObject({ conflict: false });
    expect(res.body.items[0].conflicts).toBe(2);
    expect(res.body.conflicts).toBe(2);
    // an off-day employee with a reason: shown, but not a conflict
    const std = await w.employee("R-2", "STANDARD");
    const holiday = addDays(today(), 1);
    await post(w.admin, "/v1/holidays", { name: "Баяр", fromDate: holiday, toDate: holiday });
    await post(w.hr, "/v1/reason-assignments", {
      employeeIds: [std],
      reasonId: reason,
      fromDate: holiday,
      toDate: holiday,
    });
    const c2 = cellsOf((await get(w.hr, `/v1/shift-roster?${range(4)}&employeeId=${std}`)).body);
    expect(c2[1]).toMatchObject({
      expected: false,
      reason: "HOLIDAY",
      absenceReason: "Өвчтэй",
      conflict: false,
    });
  });

  it("says what is missing instead of guessing, and uses the PRD default rules when none are saved", async () => {
    const w = await world({ week: false });
    await w.employee("M-1", "STANDARD");
    const guardTemplate = (
      await post(w.admin, "/v1/shift-templates", {
        name: "Өдөр",
        startTime: "08:00",
        endTime: "20:00",
      })
    ).body.id as string;
    const shiftEmp = await w.employee("M-2", "SHIFT");
    const res = await get(w.hr, `/v1/shift-roster?${range(2)}`);
    expect(cellsOf(res.body, 0)[0]).toMatchObject({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "WORKING_WEEK",
    });
    // a shift employee without an assignment
    expect(cellsOf(res.body, 1)[0]).toMatchObject({
      expected: false,
      reason: "NOT_CONFIGURED",
      missing: "SHIFT_ASSIGNMENT",
    });
    // with an assignment the duty is expected although no rule version was ever saved (PRD defaults)
    await post(w.hr, "/v1/shift-assignments", {
      items: [{ employeeId: shiftEmp }],
      templateId: guardTemplate,
      fromDate: today(),
    });
    const again = await get(w.hr, `/v1/shift-roster?${range(2)}&employeeId=${shiftEmp}`);
    expect(cellsOf(again.body)[0]).toMatchObject({ expected: true });
  });

  it("filters, pages and respects data scope; ranges are validated", async () => {
    const w = await world();
    const a = await w.employee("A-1", "STANDARD", w.central);
    await w.employee("A-2", "STANDARD", w.emma);
    await w.employee("A-3", "SHIFT", w.emma);
    expect((await get(w.hr, `/v1/shift-roster?${range(2)}`)).body.total).toBe(3);
    expect((await get(w.hr, `/v1/shift-roster?${range(2)}&locationId=${w.emma}`)).body.total).toBe(
      2,
    );
    expect(
      (await get(w.hr, `/v1/shift-roster?${range(2)}&scheduleMode=SHIFT`)).body.items.map(
        (i: { employeeNo: string }) => i.employeeNo,
      ),
    ).toEqual(["A-3"]);
    const page = await get(w.hr, `/v1/shift-roster?${range(2)}&limit=1&offset=1`);
    expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.body.items[0].employeeNo).toBe("A-2");
    expect(
      (await get(w.hr, `/v1/shift-roster?${range(2)}&employeeId=${a}`)).body.items,
    ).toHaveLength(1);

    expect(
      (await get(w.hr, `/v1/shift-roster?from=${today()}&to=${addDays(today(), 62)}`)).body.code,
    ).toBe("RANGE_TOO_LONG");
    expect(
      (await get(w.hr, `/v1/shift-roster?from=${today()}&to=${addDays(today(), 61)}`)).status,
    ).toBe(200);
    expect(
      (await get(w.hr, `/v1/shift-roster?from=${addDays(today(), 3)}&to=${today()}`)).status,
    ).toBe(400);
    expect((await get(w.hr, "/v1/shift-roster")).status).toBe(400);
    expect((await h.http().get(`/v1/shift-roster?${range(2)}`)).status).toBe(401);

    expect((await get(w.mgr, `/v1/shift-roster?${range(2)}`)).body.total).toBe(0);
    await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
      locationIds: [w.emma],
      departmentIds: [],
    });
    expect(
      (await get(w.mgr, `/v1/shift-roster?${range(2)}`)).body.items.map(
        (i: { employeeNo: string }) => i.employeeNo,
      ),
    ).toEqual(["A-2", "A-3"]);
  });

  it("a disabled employee drops off after leaving and is INACTIVE once gone", async () => {
    const w = await world();
    const emp = await w.employee("D-1", "STANDARD");
    await post(w.hr, `/v1/employees/${emp}/disable`, { effectiveDate: today() });
    const res = await get(w.hr, `/v1/shift-roster?${range(3)}`);
    expect(res.body.total).toBe(1); // still employed on the first day of the window
    expect(cellsOf(res.body)[1]).toMatchObject({ expected: false, reason: "INACTIVE" });
    expect(
      (await get(w.hr, `/v1/shift-roster?from=${addDays(today(), 1)}&to=${addDays(today(), 3)}`))
        .body.total,
    ).toBe(0);
  });
});
