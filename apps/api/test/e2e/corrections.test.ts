import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import { at, attendanceKit, WORK_DATE, type W } from "./attendance-kit";
import {
  auditActions,
  createEmployee,
  createUser,
  type Harness,
  signIn,
  startHarness,
} from "./harness";

describe.skipIf(!hasDb)(
  "attendance corrections (PRD 6.9) and anomaly review queue (PRD 6.7)",
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

    const resultRow = async (w: W, employeeId = w.employee.id) =>
      (
        await h.owner.query(
          `SELECT status, arrival_at, late_minutes, source, system_status, system_arrival_at, flagged_events, correction_id
           FROM attendance_result WHERE tenant_id = $1 AND employee_id = $2 AND work_date = $3`,
          [w.tenant.id, employeeId, WORK_DATE],
        )
      ).rows[0];
    /** Day over (18:00) with nobody arriving: the employee is Ирээгүй. */
    const noShowDay = async (w: W) => {
      k.setClock("18:00");
      await k.tick(w.tenant.id);
      return signIn(h, w.hr).then((t) => t.accessToken);
    };
    const correct = (token: string, w: W, over: Record<string, unknown> = {}) =>
      k.post(token, "/v1/attendance/corrections", {
        employeeId: w.employee.id,
        workDate: WORK_DATE,
        status: "ON_TIME",
        arrivalAt: at("08:05").toISOString(),
        reasonCode: "PHONE_DEAD_LOST",
        ...over,
      });

    describe("corrections", () => {
      it("HR turns Ирээгүй into Цагтаа: the system value stays next to it, the day is badged Corrected, and it is audited", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        expect((await resultRow(w)).status).toBe("NO_SHOW");

        const res = await correct(hr, w);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          status: "ON_TIME",
          originalStatus: "NO_SHOW",
          originalArrivalAt: null,
          reasonCode: "PHONE_DEAD_LOST",
          revokedAt: null,
        });
        const row = await resultRow(w);
        expect(row).toMatchObject({
          status: "ON_TIME",
          source: "CORRECTED",
          system_status: "NO_SHOW",
          late_minutes: 0,
        });
        expect(row.arrival_at.toISOString()).toBe(at("08:05").toISOString());
        expect(row.correction_id).toBe(res.body.id);

        const daily = await k.get(hr, `/v1/attendance/daily?date=${WORK_DATE}`);
        expect(daily.body.items[0]).toMatchObject({
          status: "ON_TIME",
          source: "CORRECTED",
          systemStatus: "NO_SHOW",
        });
        expect(await auditActions(h, w.tenant.id)).toContain("attendance.correction_created");
      });

      it("a correction survives the next tick and a recompute (it is not overwritten by the system)", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        await correct(hr, w, {
          status: "LATE",
          arrivalAt: at("09:10").toISOString(),
          reasonCode: "GPS_FAULT",
        });
        k.setClock("18:30");
        await k.tick(w.tenant.id);
        await k.post(hr, "/v1/attendance/recompute", { from: WORK_DATE, to: WORK_DATE });
        expect(await resultRow(w)).toMatchObject({
          status: "LATE",
          late_minutes: 70,
          source: "CORRECTED",
        });
      });

      it("a second correction replaces the first (edit); revoking returns to the system value", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        const first = (await correct(hr, w)).body;
        const second = await correct(hr, w, {
          status: "LATE",
          arrivalAt: at("08:40").toISOString(),
        });
        expect(second.status).toBe(201);
        expect(await resultRow(w)).toMatchObject({ status: "LATE", late_minutes: 40 });
        // The first one is kept, revoked.
        const all = await k.get(
          hr,
          `/v1/attendance/corrections?from=${WORK_DATE}&to=${WORK_DATE}&includeRevoked=true`,
        );
        expect(all.body.total).toBe(2);
        expect(
          all.body.items.find((c: { id: string }) => c.id === first.id).revokedAt,
        ).not.toBeNull();
        expect(
          (await k.get(hr, `/v1/attendance/corrections?from=${WORK_DATE}&to=${WORK_DATE}`)).body
            .total,
        ).toBe(1);

        const revoked = await k.post(hr, `/v1/attendance/corrections/${second.body.id}/revoke`, {
          note: "буруу",
        });
        expect(revoked.status).toBe(200);
        expect(await resultRow(w)).toMatchObject({
          status: "NO_SHOW",
          source: "AUTO",
          correction_id: null,
        });
        expect(
          (await k.post(hr, `/v1/attendance/corrections/${second.body.id}/revoke`)).status,
        ).toBe(409);
        const actions = await auditActions(h, w.tenant.id);
        expect(actions).toContain("attendance.correction_replaced");
        expect(actions).toContain("attendance.correction_revoked");
      });

      it("keeps the system arrival when a late employee is corrected to on time without a time", async () => {
        const w = await k.world();
        k.setClock("08:40");
        await k.send(await k.emp(w), [k.ev(w)]);
        k.setClock("09:00");
        await k.tick(w.tenant.id);
        expect((await resultRow(w)).status).toBe("LATE");
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const res = await correct(hr, w, { arrivalAt: null, reasonCode: "DATA_ENTRY_ERROR" });
        expect(res.body).toMatchObject({ originalStatus: "LATE" });
        const row = await resultRow(w);
        expect(row).toMatchObject({ status: "ON_TIME", late_minutes: 0, system_status: "LATE" });
        expect(row.arrival_at.toISOString()).toBe(at("08:40").toISOString());
      });

      it("validates: reason Other needs text, Ирээгүй takes no arrival, only expected days within 31 days, never the future", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        expect((await correct(hr, w, { reasonCode: "OTHER" })).status).toBe(400);
        expect(
          (await correct(hr, w, { reasonCode: "OTHER", note: "Утас дулаанд тэсээгүй" })).status,
        ).toBe(201);
        expect((await correct(hr, w, { status: "NO_SHOW" })).body.code).toBe(
          "NO_SHOW_WITH_ARRIVAL",
        );
        expect((await correct(hr, w, { arrivalAt: at("23:59").toISOString() })).body.code).toBe(
          "ARRIVAL_IN_FUTURE",
        );
        expect((await correct(hr, w, { arrivalAt: "2026-10-04T00:00:00Z" })).body.code).toBe(
          "ARRIVAL_OUT_OF_RANGE",
        );
        expect((await correct(hr, w, { workDate: "2026-10-07" })).body.code).toBe("DATE_IN_FUTURE");
        expect((await correct(hr, w, { workDate: "2026-09-04", arrivalAt: null })).body.code).toBe(
          "CORRECTION_WINDOW_CLOSED",
        );
        // Today is 2026-10-06; 31 days back (2026-09-05) is the oldest day still allowed (the week only starts today
        // in this fixture, so that day is rejected for having nothing expected, not for being too old).
        expect(
          (await correct(hr, w, { workDate: "2026-09-05", status: "NO_SHOW", arrivalAt: null }))
            .body.code,
        ).toBe("NOT_AN_EXPECTED_DAY");
        // A holiday has nobody expected.
        await k.post(w.adminTokens.accessToken, "/v1/holidays", {
          name: "Баяр",
          fromDate: "2026-10-05",
          toDate: "2026-10-05",
          confirmRecompute: true,
        });
        expect((await correct(hr, w, { workDate: "2026-10-05", arrivalAt: null })).body.code).toBe(
          "NOT_AN_EXPECTED_DAY",
        );
      });

      it("permissions and data scope: Manager and Employee cannot correct; a scoped HR cannot reach other employees; unknown employee is 404", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        const mgrUser = await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" });
        const mgr = (await signIn(h, mgrUser)).accessToken;
        expect((await correct(mgr, w)).status).toBe(403);
        expect((await correct(await k.emp(w), w)).status).toBe(403);
        expect(
          (await k.get(mgr, `/v1/attendance/corrections?from=${WORK_DATE}&to=${WORK_DATE}`)).status,
        ).toBe(403);

        const otherLoc = (
          await h.owner.query<{ id: string }>(
            "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Өөр', 47.9, 106.9, 150) RETURNING id",
            [w.tenant.id],
          )
        ).rows[0]!.id;
        await h.owner.query(
          "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
          [w.tenant.id, w.hr.id, otherLoc],
        );
        expect((await correct(hr, w)).status).toBe(404);
        expect(
          (await correct(hr, w, { employeeId: "00000000-0000-4000-8000-000000000000" })).status,
        ).toBe(404);
      });

      it("the Corrections report: by actor, reason and location with a correction rate, alert above 10 a day, Org Admin only", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        // 11 more employees, all no-show at the end of the day.
        const extra = [];
        for (let i = 0; i < 10; i++) extra.push(await createEmployee(h, w.tenant));
        await k.tick(w.tenant.id);
        await k.post(hr, "/v1/attendance/recompute", { from: WORK_DATE, to: WORK_DATE });
        for (const e of extra) {
          await correct(hr, w, { employeeId: e.id, reasonCode: "APP_ISSUE" });
        }
        await correct(hr, w, { reasonCode: "GPS_FAULT" });
        const admin = (await signIn(h, w.admin)).accessToken;
        const rep = await k.get(
          admin,
          `/v1/attendance/corrections/report?from=${WORK_DATE}&to=${WORK_DATE}`,
        );
        expect(rep.status).toBe(200);
        expect(rep.body).toMatchObject({
          made: 11,
          active: 11,
          revoked: 0,
          alertThresholdPerDay: 10,
        });
        expect(rep.body.byActor).toEqual([expect.objectContaining({ name: "hr", count: 11 })]);
        expect(rep.body.byReason).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reasonCode: "APP_ISSUE", count: 10 }),
            expect.objectContaining({ reasonCode: "GPS_FAULT", count: 1 }),
          ]),
        );
        // 13 employees expected that day (the two with devices + 10 + 1 more correction target), 11 corrected.
        expect(rep.body.byLocation).toHaveLength(1);
        expect(rep.body.byLocation[0].corrections).toBe(11);
        expect(rep.body.byLocation[0].duties).toBeGreaterThanOrEqual(11);
        expect(rep.body.alerts).toEqual([expect.objectContaining({ name: "hr", count: 11 })]);
        expect(
          (await k.get(hr, `/v1/attendance/corrections/report?from=${WORK_DATE}&to=${WORK_DATE}`))
            .status,
        ).toBe(403);
      });

      it("summary counts the corrected day as on time and shows how many days were corrected", async () => {
        const w = await k.world();
        const hr = await noShowDay(w);
        await correct(hr, w);
        const s = await k.get(hr, `/v1/attendance/summary?date=${WORK_DATE}`);
        expect(s.body).toMatchObject({ total: 2, onTime: 1, noShow: 1, corrected: 1 });
      });
    });

    describe("anomaly review queue", () => {
      const mock = (w: W, over: Record<string, unknown> = {}) =>
        k.ev(w, { mockLocation: true, ...over });
      const queue = (token: string, q = "") => k.get(token, `/v1/attendance/anomalies${q}`);
      const review = (token: string, id: string, body: object) =>
        k.post(token, `/v1/attendance/anomalies/${id}/review`, body);

      it("a mock-location ENTER is accepted and counts, but is flagged and queued; the day shows N flagged", async () => {
        const w = await k.world();
        k.setClock("08:05");
        const res = await k.send(await k.emp(w), [mock(w)]);
        expect(res.body.results[0]).toMatchObject({
          outcome: "ACCEPTED",
          counted: true,
          flags: ["MOCK_LOCATION"],
        });
        k.setClock("08:10");
        await k.tick(w.tenant.id);
        expect(await resultRow(w)).toMatchObject({ status: "ON_TIME", flagged_events: 1 });

        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const q = await queue(hr);
        expect(q.body.total).toBe(1);
        expect(q.body.items[0]).toMatchObject({
          employeeNo: expect.any(String),
          type: "ENTER",
          flags: ["MOCK_LOCATION"],
          reviewStatus: "PENDING",
          counted: true,
        });
        const s = await k.get(hr, `/v1/attendance/summary?date=${WORK_DATE}`);
        expect(s.body.flagged).toBe(1);
      });

      it("Confirm clears the flag and keeps the status; Reject stops the event counting and the day is rebuilt to Ирээгүй", async () => {
        const w = await k.world();
        k.setClock("08:05");
        await k.send(await k.emp(w), [mock(w)]);
        await k.send(await k.second(w), [mock(w)]);
        k.setClock("17:00");
        await k.tick(w.tenant.id);
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const items = (await queue(hr)).body.items as Array<{ id: string; employeeId: string }>;
        expect(items).toHaveLength(2);
        const mine = items.find((i) => i.employeeId === w.employee.id)!;
        const theirs = items.find((i) => i.employeeId === w.second.employee.id)!;

        const confirmed = await review(hr, mine.id, { decision: "CONFIRM" });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toMatchObject({
          reviewStatus: "CONFIRMED",
          reviewedByName: "hr",
          counted: true,
        });
        expect(await resultRow(w)).toMatchObject({ status: "ON_TIME", flagged_events: 0 });

        expect((await review(hr, theirs.id, { decision: "REJECT" })).status).toBe(400); // a reason is needed
        const rejected = await review(hr, theirs.id, {
          decision: "REJECT",
          note: "Хуурамч байршил",
        });
        expect(rejected.body).toMatchObject({ reviewStatus: "REJECTED", counted: false });
        expect(await resultRow(w, w.second.employee.id)).toMatchObject({
          status: "NO_SHOW",
          flagged_events: 0,
        });

        expect((await queue(hr)).body.total).toBe(0);
        expect((await queue(hr, "?status=ALL")).body.total).toBe(2);
        expect((await review(hr, mine.id, { decision: "CONFIRM" })).status).toBe(409); // decided already
        expect(await auditActions(h, w.tenant.id)).toContain("attendance.anomaly_reviewed");
      });

      it("an imprecise ENTER is queued while held back; confirming it makes it count", async () => {
        const w = await k.world();
        k.setClock("08:05");
        const res = await k.send(await k.emp(w), [k.ev(w, { accuracyM: 80 })]);
        expect(res.body.results[0]).toMatchObject({ counted: false, flags: ["LOW_ACCURACY"] });
        k.setClock("09:00");
        await k.tick(w.tenant.id);
        expect(await resultRow(w)).toMatchObject({ status: "PENDING", flagged_events: 1 });
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const item = (await queue(hr)).body.items[0];
        await review(hr, item.id, { decision: "CONFIRM" });
        expect(await resultRow(w)).toMatchObject({ status: "ON_TIME", flagged_events: 0 });
      });

      it("an event older than 24 h is not suspicious (not queued), and confirming never revives it", async () => {
        const w = await k.world();
        k.setClock("08:05");
        await k.send(await k.emp(w), [k.ev(w, { ageMs: 25 * 3_600_000 })]);
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        expect((await queue(hr)).body.total).toBe(0);
        // Both flags: too old AND a mock fix -> it is queued, but Confirm cannot make a too-old event count.
        await k.send(await k.emp(w), [mock(w, { ageMs: 25 * 3_600_000 })]);
        const item = (await queue(hr)).body.items[0];
        expect((await review(hr, item.id, { decision: "CONFIRM" })).body.counted).toBe(false);
      });

      it("Request re-check keeps the item open once; it can be decided afterwards", async () => {
        const w = await k.world();
        k.setClock("08:05");
        await k.send(await k.emp(w), [mock(w)]);
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const item = (await queue(hr)).body.items[0];
        expect(
          (await review(hr, item.id, { decision: "REQUEST_RECHECK", note: "Ажилтантай ярь" })).body
            .reviewStatus,
        ).toBe("RECHECK_REQUESTED");
        expect((await queue(hr)).body.total).toBe(1);
        expect((await review(hr, item.id, { decision: "REQUEST_RECHECK" })).status).toBe(409);
        expect((await review(hr, item.id, { decision: "CONFIRM" })).body.reviewStatus).toBe(
          "CONFIRMED",
        );
      });

      it("three flagged events within seven days mark the employee as repeated", async () => {
        const w = await k.world();
        k.setClock("08:05");
        await k.send(await k.emp(w), [mock(w), mock(w), mock(w)]);
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const q = await queue(hr);
        expect(q.body.repeated).toMatchObject({ threshold: 3, days: 7 });
        expect(q.body.repeated.employees).toEqual([
          expect.objectContaining({ employeeId: w.employee.id, count: 3 }),
        ]);
      });

      it("only HR and Org Admin review, a Manager is refused, and a scoped HR cannot see other locations' events", async () => {
        const w = await k.world();
        k.setClock("08:05");
        await k.send(await k.emp(w), [mock(w)]);
        const hr = await signIn(h, w.hr).then((t) => t.accessToken);
        const item = (await queue(hr)).body.items[0];
        const mgr = (
          await signIn(h, await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" }))
        ).accessToken;
        expect((await queue(mgr)).status).toBe(403);
        expect((await review(mgr, item.id, { decision: "CONFIRM" })).status).toBe(403);
        const otherLoc = (
          await h.owner.query<{ id: string }>(
            "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Өөр', 47.9, 106.9, 150) RETURNING id",
            [w.tenant.id],
          )
        ).rows[0]!.id;
        await h.owner.query(
          "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
          [w.tenant.id, w.hr.id, otherLoc],
        );
        expect((await queue(hr)).body.total).toBe(0);
        expect((await review(hr, item.id, { decision: "CONFIRM" })).status).toBe(404);
      });
    });
  },
);
