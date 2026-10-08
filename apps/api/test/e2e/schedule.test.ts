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

describe.skipIf(!hasDb)("working week, holidays and shifts API (PRD 14, 23)", () => {
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
    const employee = async (
      no: string,
      scheduleMode: "STANDARD" | "SHIFT" = "SHIFT",
      location = central,
    ) =>
      (
        await post(hr, "/v1/employees", {
          employeeNo: no,
          fullName: `Name ${no}`,
          departmentId: dept,
          primaryLocationId: location,
          scheduleMode,
        })
      ).body.id as string;
    return { tenant, admin, hr, mgr, mgrUser, dept, central, emma, employee };
  }

  const standardWeek = (overrides: Record<number, { start: string; end: string } | null> = {}) =>
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
      const o = overrides[weekday];
      if (o === null) return { weekday, working: false };
      if (o) return { weekday, working: true, start: o.start, end: o.end };
      return weekday <= 5
        ? { weekday, working: true, start: "08:30", end: "17:30" }
        : { weekday, working: false };
    });

  // ------------------------------------------------------------------------------------------ working week

  describe("working week (PRD 14.1)", () => {
    it("Org Admin sets the tenant week; others read; it validates the table", async () => {
      const w = await world();
      expect((await get(w.hr, "/v1/working-week")).body.code).toBe("WORKING_WEEK_NOT_CONFIGURED");
      expect((await put(w.hr, "/v1/working-week", { days: standardWeek() })).status).toBe(403);
      expect((await put(w.mgr, "/v1/working-week", { days: standardWeek() })).status).toBe(403);
      expect((await h.http().put("/v1/working-week").send({ days: standardWeek() })).status).toBe(
        401,
      );

      const set = await put(w.admin, "/v1/working-week", { days: standardWeek() });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ locationId: null, validFrom: today(), validTo: null });
      expect(set.body.days).toHaveLength(7);
      expect(set.body.days[0]).toEqual({ weekday: 1, working: true, start: "08:30", end: "17:30" });
      expect(set.body.days[5]).toEqual({ weekday: 6, working: false, start: null, end: null });

      const read = await get(w.mgr, "/v1/working-week");
      expect(read.status).toBe(200);
      expect(read.body.inherited).toBe(false);
      expect(await auditActions(h, w.tenant.id)).toContain("working_week.changed");

      const bad = (days: object[]) => put(w.admin, "/v1/working-week", { days });
      expect((await bad(standardWeek().slice(0, 6))).status).toBe(400);
      expect((await bad(standardWeek().map((d) => ({ ...d, weekday: 1 })))).status).toBe(400);
      expect((await bad(standardWeek({ 2: { start: "17:30", end: "08:30" } }))).status).toBe(400);
      expect((await bad(standardWeek({ 2: { start: "8:30", end: "17:30" } }))).status).toBe(400);
      expect(
        (await bad(standardWeek().map((d) => (d.weekday === 6 ? { ...d, start: "09:00" } : d))))
          .status,
      ).toBe(400);
      expect(
        (await put(w.admin, "/v1/working-week", { days: standardWeek(), bogus: 1 })).status,
      ).toBe(400);
    });

    it("a new table applies from its effective date; the past is not rewritten", async () => {
      const w = await world();
      await put(w.admin, "/v1/working-week", { days: standardWeek() });
      const past = await put(w.admin, "/v1/working-week", {
        days: standardWeek(),
        effectiveFrom: addDays(today(), -1),
      });
      expect(past.status).toBe(400);
      expect(past.body.code).toBe("EFFECTIVE_DATE_IN_PAST");
      const sameDay = await put(w.admin, "/v1/working-week", { days: standardWeek() });
      expect(sameDay.status).toBe(409);
      expect(sameDay.body.code).toBe("EFFECTIVE_DATE_NOT_AFTER_CURRENT");

      const from = addDays(today(), 14);
      const next = await put(w.admin, "/v1/working-week", {
        effectiveFrom: from,
        days: standardWeek({ 5: { start: "08:30", end: "16:00" } }),
      });
      expect(next.status).toBe(200);
      // today still the old table, the date itself the new one
      expect((await get(w.hr, "/v1/working-week")).body.days[4].end).toBe("17:30");
      expect((await get(w.hr, `/v1/working-week?asOf=${from}`)).body.days[4].end).toBe("16:00");
      expect((await get(w.hr, `/v1/working-week?asOf=${addDays(from, -1)}`)).body.days[4].end).toBe(
        "17:30",
      );

      // a change that has not started can be replaced
      const replaced = await put(w.admin, "/v1/working-week", {
        effectiveFrom: addDays(today(), 7),
        days: standardWeek({ 5: { start: "09:00", end: "15:00" } }),
      });
      expect(replaced.status).toBe(200);
      const versions = await get(w.hr, "/v1/working-week/versions");
      expect(versions.body.map((v: { validFrom: string }) => v.validFrom)).toEqual([
        addDays(today(), 7),
        today(),
      ]);
      expect(versions.body[1].validTo).toBe(addDays(today(), 7));
      expect(versions.body[0].validTo).toBeNull();
    });

    it("a location can have its own table and go back to the default", async () => {
      const w = await world();
      await put(w.admin, "/v1/working-week", { days: standardWeek() });
      expect((await get(w.hr, `/v1/working-week?locationId=${w.emma}`)).body.inherited).toBe(true);
      const own = await put(w.admin, "/v1/working-week", {
        locationId: w.emma,
        days: standardWeek({ 1: { start: "09:00", end: "18:00" } }),
      });
      expect(own.status).toBe(200);
      const read = await get(w.hr, `/v1/working-week?locationId=${w.emma}`);
      expect(read.body).toMatchObject({ inherited: false, locationId: w.emma });
      expect(read.body.days[0].start).toBe("09:00");
      expect((await get(w.hr, "/v1/working-week")).body.days[0].start).toBe("08:30");
      expect((await get(w.hr, `/v1/locations/${w.emma}`)).body.workingWeekMode).toBe("OVERRIDE");
      expect(
        (
          await put(w.admin, "/v1/working-week", {
            locationId: "00000000-0000-4000-8000-000000000000",
            days: standardWeek(),
          })
        ).status,
      ).toBe(404);

      // going back: from tomorrow the location inherits; today the override still applies
      const back = await post(w.admin, "/v1/working-week/inherit", {
        locationId: w.emma,
        effectiveFrom: addDays(today(), 1),
      });
      expect(back.status).toBe(200);
      expect((await get(w.hr, `/v1/locations/${w.emma}`)).body.workingWeekMode).toBe("INHERIT");
      expect(
        (await get(w.hr, `/v1/working-week?locationId=${w.emma}&asOf=${addDays(today(), 1)}`)).body
          .inherited,
      ).toBe(true);
      expect((await get(w.hr, `/v1/working-week?locationId=${w.emma}`)).body.inherited).toBe(false);
      const again = await post(w.admin, "/v1/working-week/inherit", { locationId: w.emma });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("LOCATION_NOT_OVERRIDDEN");
    });

    it("working-day exceptions: one per scope and date, working days may carry their own hours", async () => {
      const w = await world();
      expect(
        (await post(w.hr, "/v1/working-day-exceptions", { date: "2026-12-05", working: true }))
          .status,
      ).toBe(403);
      const sat = await post(w.admin, "/v1/working-day-exceptions", {
        date: "2026-12-05",
        working: true,
        start: "09:00",
        end: "13:00",
        note: "Шилжүүлсэн ажлын өдөр",
      });
      expect(sat.status).toBe(201);
      const dup = await post(w.admin, "/v1/working-day-exceptions", {
        date: "2026-12-05",
        working: false,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("EXCEPTION_EXISTS");
      // another scope (a location) on the same date is fine
      expect(
        (
          await post(w.admin, "/v1/working-day-exceptions", {
            date: "2026-12-05",
            working: false,
            locationId: w.emma,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await post(w.admin, "/v1/working-day-exceptions", {
            date: "2026-12-06",
            working: false,
            start: "09:00",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.admin, "/v1/working-day-exceptions", {
            date: "2026-12-06",
            working: true,
            start: "09:00",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.admin, "/v1/working-day-exceptions", {
            date: "2026-12-06",
            working: true,
            start: "13:00",
            end: "09:00",
          })
        ).status,
      ).toBe(400);

      const list = await get(w.mgr, "/v1/working-day-exceptions?from=2026-12-01&to=2026-12-31");
      expect(list.body).toHaveLength(2);
      expect(list.body[0]).toMatchObject({
        date: "2026-12-05",
        working: true,
        start: "09:00",
        end: "13:00",
        locationId: null,
      });
      expect((await del(w.admin, `/v1/working-day-exceptions/${sat.body.id}`)).status).toBe(204);
      expect((await del(w.admin, `/v1/working-day-exceptions/${sat.body.id}`)).status).toBe(404);
      expect(await auditActions(h, w.tenant.id)).toContain("working_day_exception.deleted");
    });
  });

  // ------------------------------------------------------------------------------------------ holidays

  describe("holidays (PRD 14.2)", () => {
    const future = () => addDays(today(), 60);

    it("Org Admin manages the calendar; everyone with access reads it", async () => {
      const w = await world();
      const body = { name: "Шинэ жил", fromDate: future(), toDate: future(), repeatsYearly: true };
      expect((await post(w.hr, "/v1/holidays", body)).status).toBe(403);
      const created = await post(w.admin, "/v1/holidays", body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: "Шинэ жил",
        kind: "PUBLIC_HOLIDAY",
        repeatsYearly: true,
        appliesToAll: true,
        locationIds: [],
      });
      expect((await get(w.mgr, `/v1/holidays/${created.body.id}`)).body.name).toBe("Шинэ жил");
      expect((await get(w.hr, "/v1/holidays/00000000-0000-4000-8000-000000000000")).status).toBe(
        404,
      );
      const dup = await post(w.admin, "/v1/holidays", body);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("HOLIDAY_EXISTS");
      expect(await auditActions(h, w.tenant.id)).toContain("holiday.created");
    });

    it("scope, dates and kind are validated; a holiday can apply to selected locations", async () => {
      const w = await world();
      const base = {
        name: "Хот байгуулсан өдөр",
        fromDate: future(),
        toDate: addDays(future(), 1),
      };
      const some = await post(w.admin, "/v1/holidays", {
        ...base,
        appliesToAll: false,
        locationIds: [w.emma, w.emma],
      });
      expect(some.status).toBe(201);
      expect(some.body).toMatchObject({ appliesToAll: false, locationIds: [w.emma] });
      expect(
        (
          await post(w.admin, "/v1/holidays", {
            ...base,
            name: "A",
            appliesToAll: false,
            locationIds: [],
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(w.admin, "/v1/holidays", { ...base, name: "B", locationIds: [w.emma] })).status,
      ).toBe(400);
      expect(
        (await post(w.admin, "/v1/holidays", { ...base, name: "C", toDate: addDays(future(), -1) }))
          .status,
      ).toBe(400);
      expect(
        (await post(w.admin, "/v1/holidays", { ...base, name: "D", toDate: addDays(future(), 40) }))
          .status,
      ).toBe(400);
      expect(
        (await post(w.admin, "/v1/holidays", { ...base, name: "E", kind: "OTHER" })).status,
      ).toBe(400);
      expect(
        (await post(w.admin, "/v1/holidays", { ...base, name: "F", fromDate: "2026-02-30" }))
          .status,
      ).toBe(400);
      const unknown = await post(w.admin, "/v1/holidays", {
        ...base,
        name: "G",
        appliesToAll: false,
        locationIds: ["00000000-0000-4000-8000-000000000000"],
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe("LOCATION_NOT_FOUND");

      // filters: by location and by dates
      await post(w.admin, "/v1/holidays", {
        name: "Бүгд",
        fromDate: addDays(future(), 10),
        toDate: addDays(future(), 10),
      });
      const forCentral = await get(w.hr, `/v1/holidays?locationId=${w.central}&from=${future()}`);
      expect(forCentral.body.map((x: { name: string }) => x.name)).toEqual(["Бүгд"]);
      const forEmma = await get(w.hr, `/v1/holidays?locationId=${w.emma}&from=${future()}`);
      expect(forEmma.body).toHaveLength(2);
      expect(
        (await get(w.hr, `/v1/holidays?from=${addDays(future(), 5)}&to=${addDays(future(), 9)}`))
          .body,
      ).toEqual([]);
    });

    it("edits and deletes; anything touching today or the past needs a recompute confirmation", async () => {
      const w = await world();
      const created = (
        await post(w.admin, "/v1/holidays", {
          name: "Цагаан сар",
          fromDate: future(),
          toDate: addDays(future(), 2),
        })
      ).body;
      const edited = await patch(w.admin, `/v1/holidays/${created.id}`, {
        name: "Цагаан сар (өөрчилсөн)",
        appliesToAll: false,
        locationIds: [w.emma],
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ appliesToAll: false, locationIds: [w.emma] });
      const backToAll = await patch(w.admin, `/v1/holidays/${created.id}`, { appliesToAll: true });
      expect(backToAll.body).toMatchObject({ appliesToAll: true, locationIds: [] });
      expect((await patch(w.admin, `/v1/holidays/${created.id}`, {})).status).toBe(400);
      expect(
        (await patch(w.admin, `/v1/holidays/${created.id}`, { toDate: addDays(future(), -3) }))
          .status,
      ).toBe(400);

      const pastBody = { name: "Өчигдөр", fromDate: addDays(today(), -1), toDate: today() };
      const blocked = await post(w.admin, "/v1/holidays", pastBody);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("RECOMPUTE_CONFIRMATION_REQUIRED");
      // today itself already has attendance, so it counts as "the past" too; tomorrow does not
      const todayOnly = await post(w.admin, "/v1/holidays", {
        name: "Өнөөдөр",
        fromDate: today(),
        toDate: today(),
      });
      expect(todayOnly.body.code).toBe("RECOMPUTE_CONFIRMATION_REQUIRED");
      const tomorrow = await post(w.admin, "/v1/holidays", {
        name: "Маргааш",
        fromDate: addDays(today(), 1),
        toDate: addDays(today(), 1),
      });
      expect(tomorrow.status).toBe(201);
      const confirmed = await post(w.admin, "/v1/holidays", {
        ...pastBody,
        confirmRecompute: true,
      });
      expect(confirmed.status).toBe(201);
      // moving a future holiday into the past is also an attendance change
      expect(
        (
          await patch(w.admin, `/v1/holidays/${created.id}`, {
            fromDate: addDays(today(), -3),
            toDate: addDays(today(), -3),
          })
        ).body.code,
      ).toBe("RECOMPUTE_CONFIRMATION_REQUIRED");
      expect((await del(w.admin, `/v1/holidays/${confirmed.body.id}`)).body.code).toBe(
        "RECOMPUTE_CONFIRMATION_REQUIRED",
      );
      expect(
        (await del(w.admin, `/v1/holidays/${confirmed.body.id}?confirmRecompute=true`)).status,
      ).toBe(204);
      expect((await del(w.admin, `/v1/holidays/${created.id}`)).status).toBe(204);
      expect((await del(w.admin, `/v1/holidays/${created.id}`)).status).toBe(404);
      const actions = await auditActions(h, w.tenant.id);
      expect(actions).toEqual(expect.arrayContaining(["holiday.updated", "holiday.deleted"]));
    });

    it("copies a year forward, skipping what already exists (29 February clamps)", async () => {
      const w = await world();
      const year = new Date(h.clock.now()).getUTCFullYear() + 1;
      const next = year + 1;
      await post(w.admin, "/v1/holidays", {
        name: "Шинэ жил",
        fromDate: `${year}-01-01`,
        toDate: `${year}-01-01`,
        repeatsYearly: true,
      });
      await post(w.admin, "/v1/holidays", {
        name: "Хоёр дахь",
        fromDate: `${year}-02-28`,
        toDate: `${year}-03-01`,
      });
      await post(w.admin, "/v1/holidays", {
        name: "Нэмэлт",
        fromDate: `${year}-05-01`,
        toDate: `${year}-05-01`,
        appliesToAll: false,
        locationIds: [w.emma],
      });
      const copied = await post(w.admin, "/v1/holidays/copy-year", {
        fromYear: year,
        toYear: next,
      });
      expect(copied.status).toBe(200);
      expect(copied.body).toEqual({ created: 3, skipped: 0 });
      const list = await get(w.hr, `/v1/holidays?year=${next}`);
      expect(list.body.map((x: { name: string }) => x.name)).toEqual([
        "Шинэ жил",
        "Хоёр дахь",
        "Нэмэлт",
      ]);
      expect(list.body[2]).toMatchObject({ appliesToAll: false, locationIds: [w.emma] });
      expect(
        (await post(w.admin, "/v1/holidays/copy-year", { fromYear: year, toYear: next })).body,
      ).toEqual({ created: 0, skipped: 3 });
      expect(
        (await post(w.admin, "/v1/holidays/copy-year", { fromYear: year, toYear: year })).status,
      ).toBe(400);
      expect(
        (await post(w.hr, "/v1/holidays/copy-year", { fromYear: year, toYear: next })).status,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------ shifts

  describe("shift templates and patterns (PRD 23.1)", () => {
    it("creates a template from start and end time (overnight and 24 h included)", async () => {
      const w = await world();
      expect(
        (
          await post(w.hr, "/v1/shift-templates", {
            name: "Өдөр",
            startTime: "08:00",
            endTime: "20:00",
          })
        ).status,
      ).toBe(403);
      const day = await post(w.admin, "/v1/shift-templates", {
        name: "Өдрийн ээлж",
        startTime: "08:00",
        endTime: "20:00",
      });
      expect(day.status).toBe(201);
      expect(day.body).toMatchObject({
        startTime: "08:00",
        endTime: "20:00",
        durationMinutes: 720,
        endsNextDay: false,
        graceMinutes: 15,
        cutoffMinutes: 120,
        observesHolidays: false,
        active: true,
        inUse: false,
      });
      const night = await post(w.admin, "/v1/shift-templates", {
        name: "Шөнийн ээлж",
        startTime: "20:00",
        endTime: "08:00",
      });
      expect(night.body).toMatchObject({
        durationMinutes: 720,
        endTime: "08:00",
        endsNextDay: true,
      });
      const full = await post(w.admin, "/v1/shift-templates", {
        name: "24 цаг",
        startTime: "09:00",
        endTime: "09:00",
        graceMinutes: 30,
      });
      expect(full.body).toMatchObject({
        durationMinutes: 1440,
        endsNextDay: true,
        graceMinutes: 30,
      });
      const byDuration = await post(w.admin, "/v1/shift-templates", {
        name: "6 цаг",
        startTime: "10:00",
        durationMinutes: 360,
      });
      expect(byDuration.body.endTime).toBe("16:00");

      expect(
        (await post(w.admin, "/v1/shift-templates", { name: "x", startTime: "08:00" })).status,
      ).toBe(400);
      expect(
        (
          await post(w.admin, "/v1/shift-templates", {
            name: "x",
            startTime: "08:00",
            endTime: "20:00",
            durationMinutes: 720,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.admin, "/v1/shift-templates", {
            name: "x",
            startTime: "25:00",
            endTime: "20:00",
          })
        ).status,
      ).toBe(400);
      const dup = await post(w.admin, "/v1/shift-templates", {
        name: "Өдрийн ээлж",
        startTime: "09:00",
        endTime: "18:00",
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("SHIFT_TEMPLATE_NAME_TAKEN");
      expect((await get(w.mgr, "/v1/shift-templates")).body).toHaveLength(4);
      expect((await get(w.mgr, `/v1/shift-templates/${day.body.id}`)).body.name).toBe(
        "Өдрийн ээлж",
      );
    });

    it("an unused template can change; a used one keeps its timing and gets a new version instead", async () => {
      const w = await world();
      const t = (
        await post(w.admin, "/v1/shift-templates", {
          name: "Өдрийн ээлж",
          startTime: "08:00",
          endTime: "20:00",
        })
      ).body;
      const changed = await patch(w.admin, `/v1/shift-templates/${t.id}`, {
        startTime: "07:00",
        endTime: "19:00",
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        startTime: "07:00",
        endTime: "19:00",
        durationMinutes: 720,
      });
      expect((await patch(w.admin, `/v1/shift-templates/${t.id}`, {})).status).toBe(400);
      expect(
        (await patch(w.admin, `/v1/shift-templates/${t.id}`, { endTime: "19:00" })).status,
      ).toBe(400);

      const emp = await w.employee("S-1");
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            items: [{ employeeId: emp }],
            templateId: t.id,
            fromDate: today(),
          })
        ).status,
      ).toBe(201);
      expect((await get(w.hr, `/v1/shift-templates/${t.id}`)).body.inUse).toBe(true);
      const blocked = await patch(w.admin, `/v1/shift-templates/${t.id}`, { startTime: "09:00" });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("SHIFT_TEMPLATE_IN_USE");
      // name and active are still editable
      expect(
        (await patch(w.admin, `/v1/shift-templates/${t.id}`, { name: "Өдөр" })).body.name,
      ).toBe("Өдөр");

      const v2 = await post(w.admin, `/v1/shift-templates/${t.id}/new-version`, {
        startTime: "09:00",
        endTime: "21:00",
        name: "Өдөр",
      });
      expect(v2.status).toBe(201);
      expect(v2.body).toMatchObject({
        name: "Өдөр",
        startTime: "09:00",
        supersedesId: t.id,
        active: true,
      });
      const old = (await get(w.hr, `/v1/shift-templates/${t.id}`)).body;
      expect(old).toMatchObject({ active: false, startTime: "07:00" });
      expect((await post(w.admin, `/v1/shift-templates/${t.id}/new-version`, {})).body.code).toBe(
        "SHIFT_TEMPLATE_RETIRED",
      );
      expect((await get(w.hr, "/v1/shift-templates?active=true")).body).toHaveLength(1);
      expect(await auditActions(h, w.tenant.id)).toContain("shift_template.superseded");
    });

    it("a 24/48 pattern is built from templates and off days, and its days freeze once assigned", async () => {
      const w = await world();
      const guard = (
        await post(w.admin, "/v1/shift-templates", {
          name: "24 цаг",
          startTime: "08:00",
          endTime: "08:00",
        })
      ).body.id as string;
      const pattern = await post(w.admin, "/v1/shift-patterns", {
        name: "24/48",
        days: [guard, null, null],
      });
      expect(pattern.status).toBe(201);
      expect(pattern.body).toMatchObject({
        cycleLengthDays: 3,
        days: [guard, null, null],
        active: true,
        inUse: false,
      });
      expect(
        (await post(w.admin, "/v1/shift-patterns", { name: "24/48", days: [guard, null, null] }))
          .body.code,
      ).toBe("SHIFT_PATTERN_NAME_TAKEN");
      expect(
        (await post(w.admin, "/v1/shift-patterns", { name: "Хоосон", days: [null, null] })).body
          .code,
      ).toBe("PATTERN_HAS_NO_WORK_DAY");
      expect(
        (
          await post(w.admin, "/v1/shift-patterns", {
            name: "Тодорхойгүй",
            days: ["00000000-0000-4000-8000-000000000000"],
          })
        ).body.code,
      ).toBe("SHIFT_TEMPLATE_NOT_FOUND");
      expect((await post(w.admin, "/v1/shift-patterns", { name: "x", days: [] })).status).toBe(400);
      expect((await post(w.hr, "/v1/shift-patterns", { name: "y", days: [guard] })).status).toBe(
        403,
      );
      expect((await get(w.mgr, `/v1/shift-patterns/${pattern.body.id}`)).body.days).toEqual([
        guard,
        null,
        null,
      ]);

      const emp = await w.employee("G-1");
      await post(w.hr, "/v1/shift-assignments", {
        items: [{ employeeId: emp }],
        patternId: pattern.body.id,
        fromDate: today(),
      });
      expect((await get(w.hr, `/v1/shift-patterns/${pattern.body.id}`)).body.inUse).toBe(true);
      // rename / retire still work
      expect(
        (await patch(w.admin, `/v1/shift-patterns/${pattern.body.id}`, { name: "24 цаг / 48 цаг" }))
          .body.name,
      ).toBe("24 цаг / 48 цаг");
      // a retired template cannot join a new pattern
      await patch(w.admin, `/v1/shift-templates/${guard}`, { active: false });
      expect(
        (await post(w.admin, "/v1/shift-patterns", { name: "Шинэ", days: [guard] })).body.code,
      ).toBe("SHIFT_TEMPLATE_INACTIVE");
    });
  });

  describe("shift assignments and overrides (PRD 23.4)", () => {
    async function shiftWorld() {
      const w = await world();
      const day = (
        await post(w.admin, "/v1/shift-templates", {
          name: "Өдөр",
          startTime: "08:00",
          endTime: "20:00",
        })
      ).body.id as string;
      const night = (
        await post(w.admin, "/v1/shift-templates", {
          name: "Шөнө",
          startTime: "20:00",
          endTime: "08:00",
        })
      ).body.id as string;
      const pattern = (
        await post(w.admin, "/v1/shift-patterns", {
          name: "Өдөр/шөнө/амралт",
          days: [day, night, null, null],
        })
      ).body.id as string;
      return { ...w, day, night, pattern };
    }

    it("assigns a team a rotation with staggered cycle starts, all or nothing", async () => {
      const w = await shiftWorld();
      const [a, b, c] = [await w.employee("T-1"), await w.employee("T-2"), await w.employee("T-3")];
      const start = today();
      const res = await post(w.hr, "/v1/shift-assignments", {
        patternId: w.pattern,
        fromDate: start,
        cycleStartDate: start,
        items: [
          { employeeId: a },
          { employeeId: b, cycleStartDate: addDays(start, 1) },
          { employeeId: c, cycleStartDate: addDays(start, 2) },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(3);
      const list = await get(w.hr, "/v1/shift-assignments");
      expect(list.body).toHaveLength(3);
      expect(list.body[1]).toMatchObject({
        employeeNo: "T-2",
        patternName: "Өдөр/шөнө/амралт",
        cycleStartDate: addDays(start, 1),
        toDate: null,
      });
      expect((await get(w.hr, `/v1/shift-assignments?employeeId=${c}`)).body).toHaveLength(1);

      // one bad item rolls everything back: employee d is fine, a already has an assignment
      const d = await w.employee("T-4");
      const overlap = await post(w.hr, "/v1/shift-assignments", {
        patternId: w.pattern,
        fromDate: start,
        items: [{ employeeId: d }, { employeeId: a }],
      });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe("SHIFT_ASSIGNMENT_OVERLAP");
      expect((await get(w.hr, `/v1/shift-assignments?employeeId=${d}`)).body).toEqual([]);
      expect(await auditActions(h, w.tenant.id)).toContain("shift_assignment.created");
    });

    it("validates who and what can be assigned", async () => {
      const w = await shiftWorld();
      const standard = await w.employee("STD-1", "STANDARD");
      const shiftEmp = await w.employee("SH-1");
      const ok = { patternId: w.pattern, fromDate: today() };
      const mode = await post(w.hr, "/v1/shift-assignments", {
        ...ok,
        items: [{ employeeId: standard }],
      });
      expect(mode.status).toBe(400);
      expect(mode.body.code).toBe("SHIFT_MODE_REQUIRED");
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            ...ok,
            items: [{ employeeId: "00000000-0000-4000-8000-000000000000" }],
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            items: [{ employeeId: shiftEmp }],
            fromDate: today(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            ...ok,
            templateId: w.day,
            items: [{ employeeId: shiftEmp }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            templateId: w.day,
            cycleStartDate: today(),
            fromDate: today(),
            items: [{ employeeId: shiftEmp }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            ...ok,
            toDate: addDays(today(), -1),
            items: [{ employeeId: shiftEmp }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            ...ok,
            items: [{ employeeId: shiftEmp }, { employeeId: shiftEmp }],
          })
        ).status,
      ).toBe(400);
      expect((await post(w.hr, "/v1/shift-assignments", { ...ok, items: [] })).status).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            patternId: "00000000-0000-4000-8000-000000000000",
            fromDate: today(),
            items: [{ employeeId: shiftEmp }],
          })
        ).body.code,
      ).toBe("SHIFT_PATTERN_NOT_FOUND");
      expect(
        (await post(w.mgr, "/v1/shift-assignments", { ...ok, items: [{ employeeId: shiftEmp }] }))
          .status,
      ).toBe(403);
      // a fixed template works too, and defaults the cycle for patterns to the start date
      expect(
        (
          await post(w.hr, "/v1/shift-assignments", {
            templateId: w.day,
            fromDate: today(),
            items: [{ employeeId: shiftEmp }],
          })
        ).status,
      ).toBe(201);
      const disabled = await w.employee("SH-2");
      await post(w.hr, `/v1/employees/${disabled}/disable`, {});
      expect(
        (await post(w.hr, "/v1/shift-assignments", { ...ok, items: [{ employeeId: disabled }] }))
          .body.code,
      ).toBe("EMPLOYEE_NOT_ACTIVE");
    });

    it("an assignment can be ended or, before it starts, deleted; periods then follow each other", async () => {
      const w = await shiftWorld();
      const emp = await w.employee("E-1");
      const from = addDays(today(), -10);
      const first = (
        await post(w.hr, "/v1/shift-assignments", {
          templateId: w.day,
          fromDate: from,
          items: [{ employeeId: emp }],
        })
      ).body.assignmentIds[0] as string;
      expect(
        (await post(w.hr, `/v1/shift-assignments/${first}/end`, { toDate: addDays(from, -1) }))
          .status,
      ).toBe(400);
      const ended = await post(w.hr, `/v1/shift-assignments/${first}/end`, {
        toDate: addDays(today(), -1),
      });
      expect(ended.status).toBe(200);
      // shortening only
      expect(
        (await post(w.hr, `/v1/shift-assignments/${first}/end`, { toDate: today() })).status,
      ).toBe(400);
      // the next period starts right after
      const second = await post(w.hr, "/v1/shift-assignments", {
        patternId: w.pattern,
        fromDate: today(),
        items: [{ employeeId: emp }],
      });
      expect(second.status).toBe(201);
      const listed = await get(w.hr, `/v1/shift-assignments?employeeId=${emp}`);
      expect(listed.body.map((x: { fromDate: string }) => x.fromDate)).toEqual([from, today()]);
      // started assignments cannot be deleted
      expect((await del(w.hr, `/v1/shift-assignments/${first}`)).body.code).toBe(
        "ASSIGNMENT_STARTED",
      );
      const later = (
        await post(w.hr, "/v1/shift-assignments", {
          templateId: w.day,
          fromDate: addDays(today(), 30),
          items: [{ employeeId: await w.employee("E-2") }],
        })
      ).body.assignmentIds[0] as string;
      expect((await del(w.hr, `/v1/shift-assignments/${later}`)).status).toBe(204);
      expect((await del(w.hr, `/v1/shift-assignments/${later}`)).status).toBe(404);
      expect(await auditActions(h, w.tenant.id)).toEqual(
        expect.arrayContaining(["shift_assignment.ended", "shift_assignment.deleted"]),
      );
    });

    it("overrides add, remove or swap a shift for one date", async () => {
      const w = await shiftWorld();
      const emp = await w.employee("O-1");
      const date = addDays(today(), 3);
      const add = await post(w.hr, "/v1/shift-overrides", {
        employeeId: emp,
        workDate: date,
        kind: "ADD",
        templateId: w.day,
        reason: "Нэмэлт ээлж",
      });
      expect(add.status).toBe(201);
      const dup = await post(w.hr, "/v1/shift-overrides", {
        employeeId: emp,
        workDate: date,
        kind: "REMOVE",
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("OVERRIDE_EXISTS");
      expect(
        (
          await post(w.hr, "/v1/shift-overrides", {
            employeeId: emp,
            workDate: addDays(date, 1),
            kind: "REMOVE",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await post(w.hr, "/v1/shift-overrides", {
            employeeId: emp,
            workDate: addDays(date, 2),
            kind: "REMOVE",
            templateId: w.day,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-overrides", {
            employeeId: emp,
            workDate: addDays(date, 2),
            kind: "SWAP",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(w.hr, "/v1/shift-overrides", {
            employeeId: await w.employee("O-STD", "STANDARD"),
            workDate: date,
            kind: "REMOVE",
          })
        ).body.code,
      ).toBe("SHIFT_MODE_REQUIRED");
      const list = await get(w.hr, `/v1/shift-overrides?employeeId=${emp}&from=${date}&to=${date}`);
      expect(list.body).toEqual([
        expect.objectContaining({
          kind: "ADD",
          templateName: "Өдөр",
          workDate: date,
          reason: "Нэмэлт ээлж",
        }),
      ]);
      expect((await del(w.hr, `/v1/shift-overrides/${add.body.id}`)).status).toBe(204);
      expect((await del(w.hr, `/v1/shift-overrides/${add.body.id}`)).status).toBe(404);
      expect(await auditActions(h, w.tenant.id)).toContain("shift_override.created");
    });

    it("a Manager reads only the roster inside their data scope; HR scope also limits writing", async () => {
      const w = await shiftWorld();
      const inCentral = await w.employee("R-1", "SHIFT", w.central);
      const inEmma = await w.employee("R-2", "SHIFT", w.emma);
      await post(w.hr, "/v1/shift-assignments", {
        templateId: w.day,
        fromDate: today(),
        items: [{ employeeId: inCentral }, { employeeId: inEmma }],
      });
      expect((await get(w.mgr, "/v1/shift-assignments")).body).toEqual([]);
      await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
        locationIds: [w.emma],
        departmentIds: [],
      });
      const seen = await get(w.mgr, "/v1/shift-assignments");
      expect(seen.body.map((x: { employeeNo: string }) => x.employeeNo)).toEqual(["R-2"]);
      expect((await get(w.mgr, "/v1/shift-overrides")).body).toEqual([]);
    });
  });
});
