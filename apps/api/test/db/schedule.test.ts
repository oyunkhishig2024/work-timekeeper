import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asTenant, connectOwner, createFixture, hasDb, type Fixture } from "./helpers";

// SQLSTATEs: 23505 unique, 23503 foreign key, 23514 check, 23P01 exclusion; TK00x = rules raised by the migrations.
const UNIQUE = "23505";
const FK = "23503";
const CHECK = "23514";
const EXCLUSION = "23P01";

/** Runs statements in one transaction; deferred constraint triggers fire at COMMIT, so a violation rejects it. */
async function tx(client: Client, fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

describe.skipIf(!hasDb)("working week, holidays and shifts (PRD 14, 23, 22.1)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connectOwner();
  });
  afterAll(async () => {
    await client.end();
  });

  const setup = async (): Promise<Fixture> => createFixture(client);

  // ---------------------------------------------------------------- attendance rule versions

  describe("attendance rule versions (PRD 6.2–6.4)", () => {
    const rule = (
      f: Fixture,
      from: string,
      to: string | null,
      loc: string | null = null,
      extra: Record<string, number> = {},
    ) =>
      client.query(
        `INSERT INTO attendance_rule_version
           (tenant_id, location_id, valid_from, valid_to, grace_minutes, cutoff_minutes, min_stay_minutes, early_window_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          f.tenantId,
          loc,
          from,
          to,
          extra.grace ?? 15,
          extra.cutoff ?? 120,
          extra.minStay ?? 3,
          extra.early ?? 120,
        ],
      );

    it("stores the PRD defaults and forbids overlapping versions of the same scope", async () => {
      const f = await setup();
      await rule(f, "2026-01-01", null);
      const stored = await client.query(
        "SELECT grace_minutes, cutoff_minutes, min_stay_minutes, early_window_minutes FROM attendance_rule_version WHERE tenant_id = $1",
        [f.tenantId],
      );
      expect(stored.rows[0]).toEqual({
        grace_minutes: 15,
        cutoff_minutes: 120,
        min_stay_minutes: 3,
        early_window_minutes: 120,
      });

      await expect(rule(f, "2026-06-01", null)).rejects.toMatchObject({ code: EXCLUSION });
      await expect(rule(f, "2025-06-01", "2026-02-01")).rejects.toMatchObject({ code: EXCLUSION });
    });

    it("lets a location override the tenant default and versions follow each other without gaps or overlap", async () => {
      const f = await setup();
      await rule(f, "2026-01-01", "2026-07-01");
      await rule(f, "2026-07-01", null, null, { grace: 10 }); // half-open: adjacent is fine
      await rule(f, "2026-01-01", null, f.locationId, { grace: 20 }); // same dates, different scope
      const other = await client.query<{ id: string }>(
        "INSERT INTO location (tenant_id, name, lat, lng, radius_m) VALUES ($1, 'Налайх', 47.9, 106.9, 150) RETURNING id",
        [f.tenantId],
      );
      await rule(f, "2026-01-01", null, other.rows[0]!.id);
      await expect(rule(f, "2026-03-01", null, f.locationId)).rejects.toMatchObject({
        code: EXCLUSION,
      });
    });

    it.each([
      ["grace 241", { grace: 241 }],
      ["cutoff 1441", { cutoff: 1441 }],
      ["min stay 0", { minStay: 0 }],
      ["min stay 16", { minStay: 16 }],
      ["early window 721", { early: 721 }],
    ])("rejects out-of-range values (%s)", async (_label, extra) => {
      const f = await setup();
      await expect(rule(f, "2026-01-01", null, null, extra)).rejects.toMatchObject({ code: CHECK });
    });

    it("rejects an empty or reversed period and another tenant's location", async () => {
      const f = await setup();
      await expect(rule(f, "2026-05-01", "2026-05-01")).rejects.toMatchObject({ code: CHECK });
      await expect(rule(f, "2026-05-01", "2026-04-01")).rejects.toMatchObject({ code: CHECK });
      const other = await setup();
      await expect(rule(f, "2026-01-01", null, other.locationId)).rejects.toMatchObject({
        code: FK,
      });
    });
  });

  // ---------------------------------------------------------------- working week

  describe("working week (PRD 14.1)", () => {
    type Day = [weekday: number, working: boolean, start?: string, end?: string];
    const standardDays: Day[] = [
      [1, true, "08:30", "17:30"],
      [2, true, "08:30", "17:30"],
      [3, true, "08:30", "17:30"],
      [4, true, "08:30", "17:30"],
      [5, true, "08:30", "17:30"],
      [6, false],
      [7, false],
    ];
    async function insertWeek(
      f: Fixture,
      opts: { from?: string; to?: string | null; location?: string | null; days?: Day[] } = {},
    ) {
      await tx(client, async () => {
        const v = await client.query<{ id: string }>(
          "INSERT INTO working_week_version (tenant_id, location_id, valid_from, valid_to) VALUES ($1, $2, $3, $4) RETURNING id",
          [f.tenantId, opts.location ?? null, opts.from ?? "2026-01-01", opts.to ?? null],
        );
        for (const [weekday, working, start, end] of opts.days ?? standardDays) {
          await client.query(
            "INSERT INTO working_week_day (tenant_id, working_week_id, weekday, working, start_time, end_time) VALUES ($1, $2, $3, $4, $5, $6)",
            [f.tenantId, v.rows[0]!.id, weekday, working, start ?? null, end ?? null],
          );
        }
      });
    }

    it("stores Mon–Fri 08:30–17:30 with Saturday and Sunday off", async () => {
      const f = await setup();
      await insertWeek(f);
      const days = await client.query(
        "SELECT weekday, working, start_time::text, end_time::text FROM working_week_day WHERE tenant_id = $1 ORDER BY weekday",
        [f.tenantId],
      );
      expect(days.rows).toHaveLength(7);
      expect(days.rows[0]).toEqual({
        weekday: 1,
        working: true,
        start_time: "08:30:00",
        end_time: "17:30:00",
      });
      expect(days.rows[5]).toEqual({
        weekday: 6,
        working: false,
        start_time: null,
        end_time: null,
      });
    });

    it("requires all 7 weekdays by the time the transaction commits", async () => {
      const f = await setup();
      await expect(insertWeek(f, { days: standardDays.slice(0, 6) })).rejects.toMatchObject({
        code: "TK003",
      });
      await expect(insertWeek(f, { days: [] })).rejects.toMatchObject({ code: "TK003" });
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM working_week_version WHERE tenant_id = $1",
            [f.tenantId],
          )
        ).rows[0].n,
      ).toBe(0);

      await insertWeek(f);
      const v = (
        await client.query<{ id: string }>(
          "SELECT id FROM working_week_version WHERE tenant_id = $1",
          [f.tenantId],
        )
      ).rows[0]!.id;
      await expect(
        client.query("DELETE FROM working_week_day WHERE working_week_id = $1 AND weekday = 3", [
          v,
        ]),
      ).rejects.toMatchObject({ code: "TK003" });
      // Changing the times of a day is fine; deleting the whole version removes its days.
      await client.query(
        "UPDATE working_week_day SET end_time = '16:30' WHERE working_week_id = $1 AND weekday = 5",
        [v],
      );
      await client.query("DELETE FROM working_week_version WHERE id = $1", [v]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM working_week_day WHERE working_week_id = $1",
            [v],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("validates each day", async () => {
      const f = await setup();
      const bad = (days: Day[]) => insertWeek(f, { days });
      const week = (change: Day) => standardDays.map((d) => (d[0] === change[0] ? change : d));
      await expect(bad(week([1, true, "17:30", "08:30"]))).rejects.toMatchObject({ code: CHECK });
      await expect(bad(week([1, true, "08:30", "08:30"]))).rejects.toMatchObject({ code: CHECK });
      await expect(bad(week([1, true]))).rejects.toMatchObject({ code: CHECK });
      await expect(bad(week([6, false, "09:00", "13:00"]))).rejects.toMatchObject({ code: CHECK });
      await expect(bad([...standardDays.slice(0, 6), [8, false]])).rejects.toMatchObject({
        code: CHECK,
      });
      await expect(bad([...standardDays, [7, false]])).rejects.toMatchObject({ code: UNIQUE });
    });

    it("keeps one version per scope in force at any date; a location can have its own week", async () => {
      const f = await setup();
      await insertWeek(f, { from: "2026-01-01", to: "2026-07-01" });
      await insertWeek(f, { from: "2026-07-01" }); // adjacent
      await expect(insertWeek(f, { from: "2026-05-01", to: "2026-08-01" })).rejects.toMatchObject({
        code: EXCLUSION,
      });
      await insertWeek(f, {
        from: "2026-01-01",
        location: f.locationId,
        days: standardDays.map((d) => (d[0] === 6 ? ([6, true, "09:00", "13:00"] as Day) : d)),
      });
      await expect(
        insertWeek(f, { from: "2026-03-01", location: f.locationId }),
      ).rejects.toMatchObject({ code: EXCLUSION });
    });
  });

  describe("working-day exceptions (PRD 14.1)", () => {
    const exception = (
      f: Fixture,
      date: string,
      working: boolean,
      start: string | null = null,
      end: string | null = null,
      loc: string | null = null,
    ) =>
      client.query(
        "INSERT INTO working_day_exception (tenant_id, location_id, exception_date, working, start_time, end_time) VALUES ($1, $2, $3, $4, $5, $6)",
        [f.tenantId, loc, date, working, start, end],
      );

    it("allows one exception per scope and date, with or without its own hours", async () => {
      const f = await setup();
      await exception(f, "2026-10-10", true, "09:00", "13:00"); // transferred working Saturday
      await exception(f, "2026-10-17", true);
      await expect(exception(f, "2026-10-10", false)).rejects.toMatchObject({ code: UNIQUE }); // whole-tenant, same date
      await exception(f, "2026-10-10", false, null, null, f.locationId); // a location may differ
      await expect(
        exception(f, "2026-10-10", true, null, null, f.locationId),
      ).rejects.toMatchObject({ code: UNIQUE });
    });

    it("rejects inconsistent hours", async () => {
      const f = await setup();
      await expect(exception(f, "2026-10-11", true, "09:00", null)).rejects.toMatchObject({
        code: CHECK,
      });
      await expect(exception(f, "2026-10-11", true, "13:00", "09:00")).rejects.toMatchObject({
        code: CHECK,
      });
      await expect(exception(f, "2026-10-11", false, "09:00", "13:00")).rejects.toMatchObject({
        code: CHECK,
      });
    });
  });

  // ---------------------------------------------------------------- holidays

  describe("holidays (PRD 14.2)", () => {
    async function holiday(
      f: Fixture,
      o: {
        name?: string;
        from?: string;
        to?: string;
        all?: boolean;
        locations?: string[];
        yearly?: boolean;
        kind?: string;
      },
    ) {
      await tx(client, async () => {
        const h = await client.query<{ id: string }>(
          `INSERT INTO holiday (tenant_id, name, from_date, to_date, kind, repeats_yearly, applies_to_all)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            f.tenantId,
            o.name ?? "Шинэ жил",
            o.from ?? "2026-01-01",
            o.to ?? o.from ?? "2026-01-01",
            o.kind ?? "PUBLIC_HOLIDAY",
            o.yearly ?? false,
            o.all ?? true,
          ],
        );
        for (const location of o.locations ?? []) {
          await client.query(
            "INSERT INTO holiday_location (tenant_id, holiday_id, location_id) VALUES ($1, $2, $3)",
            [f.tenantId, h.rows[0]!.id, location],
          );
        }
      });
    }

    it("applies to all locations or to a non-empty list — never both, never neither", async () => {
      const f = await setup();
      await holiday(f, { name: "Бүгд", all: true });
      await holiday(f, { name: "Зөвхөн Төв", all: false, locations: [f.locationId] });
      await expect(holiday(f, { name: "Хоосон", all: false })).rejects.toMatchObject({
        code: "TK004",
      });
      await expect(
        holiday(f, { name: "Хоёулаа", all: true, locations: [f.locationId] }),
      ).rejects.toMatchObject({ code: "TK004" });

      const scoped = (
        await client.query<{ id: string }>(
          "SELECT id FROM holiday WHERE tenant_id = $1 AND name = 'Зөвхөн Төв'",
          [f.tenantId],
        )
      ).rows[0]!.id;
      await expect(
        client.query("DELETE FROM holiday_location WHERE holiday_id = $1", [scoped]),
      ).rejects.toMatchObject({ code: "TK004" });
      await tx(client, async () => {
        await client.query("DELETE FROM holiday_location WHERE holiday_id = $1", [scoped]);
        await client.query("UPDATE holiday SET applies_to_all = true WHERE id = $1", [scoped]);
      });
    });

    it("validates dates (a range is at most 31 days), names and the other tenant's locations", async () => {
      const f = await setup();
      await holiday(f, {
        name: "Цагаан сар",
        from: "2026-02-17",
        to: "2026-02-19",
        kind: "PUBLIC_HOLIDAY",
      });
      await holiday(f, { name: "Урт", from: "2026-03-01", to: "2026-03-31" }); // 30 days between
      await expect(
        holiday(f, { name: "Хэт урт", from: "2026-03-01", to: "2026-04-01" }),
      ).rejects.toMatchObject({ code: CHECK });
      await expect(
        holiday(f, { name: "Буруу", from: "2026-05-02", to: "2026-05-01" }),
      ).rejects.toMatchObject({ code: CHECK });
      await expect(holiday(f, { name: "Цагаан сар", from: "2026-02-17" })).rejects.toMatchObject({
        code: UNIQUE,
      });
      await expect(holiday(f, { name: "Төрөл", kind: "BOGUS" })).rejects.toMatchObject({
        code: CHECK,
      });
      const other = await setup();
      await expect(
        holiday(f, { name: "Бусдын", all: false, locations: [other.locationId] }),
      ).rejects.toMatchObject({ code: FK });
    });

    it("stores fixed-date (yearly) and transferred days off", async () => {
      const f = await setup();
      await holiday(f, { name: "Шинэ жил", from: "2026-01-01", yearly: true });
      await holiday(f, {
        name: "Шилжүүлсэн амралт",
        from: "2026-10-12",
        kind: "TRANSFERRED_DAY_OFF",
      });
      const rows = await client.query(
        "SELECT name, repeats_yearly, kind FROM holiday WHERE tenant_id = $1 ORDER BY name",
        [f.tenantId],
      );
      expect(rows.rows).toEqual([
        { name: "Шилжүүлсэн амралт", repeats_yearly: false, kind: "TRANSFERRED_DAY_OFF" },
        { name: "Шинэ жил", repeats_yearly: true, kind: "PUBLIC_HOLIDAY" },
      ]);
    });
  });

  // ---------------------------------------------------------------- shifts

  describe("shift templates (PRD 23.1, 22.1)", () => {
    const template = (f: Fixture, name: string, o: { start?: string; minutes?: number } = {}) =>
      client.query<{ id: string }>(
        "INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES ($1, $2, $3, $4) RETURNING id",
        [f.tenantId, name, o.start ?? "08:00", o.minutes ?? 1440],
      );

    it("holds up to 24 h shifts, including ones that cross midnight, with the PRD defaults", async () => {
      const f = await setup();
      await template(f, "24 цаг 08:00–08:00");
      await template(f, "Шөнийн 20:00–08:00", { start: "20:00", minutes: 720 });
      await expect(template(f, "Тэг", { minutes: 0 })).rejects.toMatchObject({ code: CHECK });
      await expect(template(f, "Хэт урт", { minutes: 1441 })).rejects.toMatchObject({
        code: CHECK,
      });
      const row = await client.query(
        "SELECT grace_minutes, cutoff_minutes, early_window_minutes, observes_holidays FROM shift_template WHERE tenant_id = $1 LIMIT 1",
        [f.tenantId],
      );
      expect(row.rows[0]).toEqual({
        grace_minutes: 15,
        cutoff_minutes: 120,
        early_window_minutes: 120,
        observes_holidays: false,
      });
    });

    it("active names are unique; a retired template frees its name", async () => {
      const f = await setup();
      const first = await template(f, "Өдрийн");
      await expect(template(f, "Өдрийн")).rejects.toMatchObject({ code: UNIQUE });
      await client.query("UPDATE shift_template SET active = false WHERE id = $1", [
        first.rows[0]!.id,
      ]);
      const second = await template(f, "Өдрийн");
      await client.query("UPDATE shift_template SET supersedes_id = $2 WHERE id = $1", [
        second.rows[0]!.id,
        first.rows[0]!.id,
      ]);
    });

    it("an unused template can be changed; one in use keeps its timing but can be renamed or retired", async () => {
      const f = await setup();
      const t = (await template(f, "Хувилбар 1")).rows[0]!.id;
      await client.query(
        "UPDATE shift_template SET start_time = '09:00', duration_minutes = 600 WHERE id = $1",
        [t],
      );

      await client.query("UPDATE employee SET schedule_mode = 'SHIFT' WHERE id = $1", [
        f.employeeId,
      ]);
      await client.query(
        "INSERT INTO shift_assignment (tenant_id, employee_id, template_id, from_date) VALUES ($1, $2, $3, '2026-10-01')",
        [f.tenantId, f.employeeId, t],
      );
      await expect(
        client.query("UPDATE shift_template SET start_time = '10:00' WHERE id = $1", [t]),
      ).rejects.toMatchObject({ code: "TK005" });
      await expect(
        client.query("UPDATE shift_template SET observes_holidays = true WHERE id = $1", [t]),
      ).rejects.toMatchObject({ code: "TK005" });
      await client.query(
        "UPDATE shift_template SET name = 'Хувилбар 1 (хуучин)', active = false WHERE id = $1",
        [t],
      );

      // Also protected through a pattern day or an override.
      const viaPattern = (await template(f, "Хэв маягт")).rows[0]!.id;
      await tx(client, async () => {
        const p = await client.query<{ id: string }>(
          "INSERT INTO shift_pattern (tenant_id, name, cycle_length_days) VALUES ($1, 'p1', 1) RETURNING id",
          [f.tenantId],
        );
        await client.query(
          "INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index, template_id) VALUES ($1, $2, 0, $3)",
          [f.tenantId, p.rows[0]!.id, viaPattern],
        );
      });
      await expect(
        client.query("UPDATE shift_template SET duration_minutes = 100 WHERE id = $1", [
          viaPattern,
        ]),
      ).rejects.toMatchObject({ code: "TK005" });
      const viaOverride = (await template(f, "Давхар")).rows[0]!.id;
      await client.query(
        "INSERT INTO shift_override (tenant_id, employee_id, work_date, kind, template_id) VALUES ($1, $2, '2026-11-01', 'ADD', $3)",
        [f.tenantId, f.employeeId, viaOverride],
      );
      await expect(
        client.query("UPDATE shift_template SET start_time = '07:00' WHERE id = $1", [viaOverride]),
      ).rejects.toMatchObject({ code: "TK005" });
    });
  });

  describe("shift patterns (PRD 23.1)", () => {
    async function pattern(f: Fixture, name: string, length: number, days: Array<string | null>) {
      let id = "";
      await tx(client, async () => {
        const p = await client.query<{ id: string }>(
          "INSERT INTO shift_pattern (tenant_id, name, cycle_length_days) VALUES ($1, $2, $3) RETURNING id",
          [f.tenantId, name, length],
        );
        id = p.rows[0]!.id;
        for (const [index, templateId] of days.entries()) {
          await client.query(
            "INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index, template_id) VALUES ($1, $2, $3, $4)",
            [f.tenantId, id, index, templateId],
          );
        }
      });
      return id;
    }
    const guardTemplate = async (f: Fixture, name = "24 цаг") =>
      (
        await client.query<{ id: string }>(
          "INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES ($1, $2, '08:00', 1440) RETURNING id",
          [f.tenantId, name],
        )
      ).rows[0]!.id;

    it("'24 hours on, 48 hours off' is a 3-day cycle with two off days", async () => {
      const f = await setup();
      const t = await guardTemplate(f);
      const id = await pattern(f, "24/48", 3, [t, null, null]);
      const days = await client.query(
        "SELECT day_index, template_id FROM shift_pattern_day WHERE pattern_id = $1 ORDER BY day_index",
        [id],
      );
      expect(days.rows).toEqual([
        { day_index: 0, template_id: t },
        { day_index: 1, template_id: null },
        { day_index: 2, template_id: null },
      ]);
    });

    it("must define every day 0 … length-1 exactly once", async () => {
      const f = await setup();
      const t = await guardTemplate(f);
      await expect(pattern(f, "short", 3, [t, null])).rejects.toMatchObject({ code: "TK007" });
      await expect(pattern(f, "empty", 3, [])).rejects.toMatchObject({ code: "TK007" });
      await expect(pattern(f, "extra", 2, [t, null, null])).rejects.toMatchObject({
        code: "TK007",
      });
      await expect(pattern(f, "zero", 0, [])).rejects.toMatchObject({ code: CHECK });
      await expect(
        tx(client, async () => {
          const p = await client.query<{ id: string }>(
            "INSERT INTO shift_pattern (tenant_id, name, cycle_length_days) VALUES ($1, 'gap', 2) RETURNING id",
            [f.tenantId],
          );
          await client.query(
            "INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index) VALUES ($1, $2, 0), ($1, $2, 5)",
            [f.tenantId, p.rows[0]!.id],
          );
        }),
      ).rejects.toMatchObject({ code: "TK007" });
    });

    it("an assigned pattern keeps its days and cycle length; name and active can still change", async () => {
      const f = await setup();
      const t = await guardTemplate(f);
      const p = await pattern(f, "24/48", 3, [t, null, null]);
      await client.query("UPDATE employee SET schedule_mode = 'SHIFT' WHERE id = $1", [
        f.employeeId,
      ]);
      await client.query(
        "INSERT INTO shift_assignment (tenant_id, employee_id, pattern_id, cycle_start_date, from_date) VALUES ($1, $2, $3, '2026-10-01', '2026-10-01')",
        [f.tenantId, f.employeeId, p],
      );
      await expect(
        client.query(
          "UPDATE shift_pattern_day SET template_id = NULL WHERE pattern_id = $1 AND day_index = 0",
          [p],
        ),
      ).rejects.toMatchObject({ code: "TK006" });
      await expect(
        client.query("DELETE FROM shift_pattern_day WHERE pattern_id = $1 AND day_index = 2", [p]),
      ).rejects.toMatchObject({ code: "TK006" });
      await expect(
        client.query("UPDATE shift_pattern SET cycle_length_days = 4 WHERE id = $1", [p]),
      ).rejects.toMatchObject({ code: "TK006" });
      // Deleting an assigned pattern is stopped too (its days are protected before the foreign key is checked).
      await expect(
        client.query("DELETE FROM shift_pattern WHERE id = $1", [p]),
      ).rejects.toMatchObject({ code: "TK006" });
      await client.query(
        "UPDATE shift_pattern SET name = '24/48 (хуучин)', active = false WHERE id = $1",
        [p],
      );
    });
  });

  describe("shift assignments (PRD 23.4)", () => {
    async function shiftEmployee(f: Fixture, no: string) {
      const e = await client.query<{ id: string }>(
        `INSERT INTO employee (tenant_id, employee_no, full_name, department_id, primary_location_id, schedule_mode)
         VALUES ($1, $2, $2, $3, $4, 'SHIFT') RETURNING id`,
        [f.tenantId, no, f.departmentId, f.locationId],
      );
      return e.rows[0]!.id;
    }
    const tpl = async (f: Fixture) =>
      (
        await client.query<{ id: string }>(
          "INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES ($1, $2, '08:00', 1440) RETURNING id",
          [f.tenantId, `t-${Math.random()}`],
        )
      ).rows[0]!.id;
    const assign = (
      f: Fixture,
      employeeId: string,
      templateId: string,
      from: string,
      to: string | null,
    ) =>
      client.query(
        "INSERT INTO shift_assignment (tenant_id, employee_id, template_id, from_date, to_date) VALUES ($1, $2, $3, $4, $5)",
        [f.tenantId, employeeId, templateId, from, to],
      );

    it("only employees on a shift schedule can be assigned", async () => {
      const f = await setup(); // the fixture employee is STANDARD
      await expect(assign(f, f.employeeId, await tpl(f), "2026-10-01", null)).rejects.toMatchObject(
        { code: "TK002" },
      );
      await assign(f, await shiftEmployee(f, "G-1"), await tpl(f), "2026-10-01", null);
    });

    it("gives exactly one of pattern or template, and a pattern needs its cycle start date", async () => {
      const f = await setup();
      const emp = await shiftEmployee(f, "G-1");
      const t = await tpl(f);
      let pattern = "";
      await tx(client, async () => {
        const p = await client.query<{ id: string }>(
          "INSERT INTO shift_pattern (tenant_id, name, cycle_length_days) VALUES ($1, 'one', 1) RETURNING id",
          [f.tenantId],
        );
        pattern = p.rows[0]!.id;
        await client.query(
          "INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index, template_id) VALUES ($1, $2, 0, $3)",
          [f.tenantId, pattern, t],
        );
      });
      const insert = (
        patternId: string | null,
        templateId: string | null,
        cycleStart: string | null,
      ) =>
        client.query(
          `INSERT INTO shift_assignment (tenant_id, employee_id, pattern_id, template_id, cycle_start_date, from_date)
           VALUES ($1, $2, $3, $4, $5, '2026-10-01')`,
          [f.tenantId, emp, patternId, templateId, cycleStart],
        );
      await expect(insert(null, null, null)).rejects.toMatchObject({ code: CHECK });
      await expect(insert(pattern, t, "2026-10-01")).rejects.toMatchObject({ code: CHECK });
      await expect(insert(pattern, null, null)).rejects.toMatchObject({ code: CHECK });
      await insert(pattern, null, "2026-10-01");
      await expect(
        client.query(
          "INSERT INTO shift_assignment (tenant_id, employee_id, template_id, from_date, to_date) VALUES ($1, $2, $3, '2026-12-05', '2026-12-01')",
          [f.tenantId, emp, t],
        ),
      ).rejects.toMatchObject({ code: CHECK });
    });

    it("an employee has one assignment at any date; adjacent ranges and other employees are fine", async () => {
      const f = await setup();
      const a = await shiftEmployee(f, "G-1");
      const b = await shiftEmployee(f, "G-2");
      const t = await tpl(f);
      await assign(f, a, t, "2026-10-01", "2026-10-31");
      await expect(assign(f, a, t, "2026-10-31", "2026-11-30")).rejects.toMatchObject({
        code: EXCLUSION,
      });
      await assign(f, a, t, "2026-11-01", null); // adjacent and open-ended
      await expect(assign(f, a, t, "2027-01-01", null)).rejects.toMatchObject({ code: EXCLUSION });
      await assign(f, b, t, "2026-10-01", null);
    });

    it("cannot reference another tenant's template or employee", async () => {
      const f = await setup();
      const other = await setup();
      const emp = await shiftEmployee(f, "G-1");
      await expect(assign(f, emp, await tpl(other), "2026-10-01", null)).rejects.toMatchObject({
        code: FK,
      });
      // An employee of another tenant is simply not found for this tenant.
      await expect(
        assign(f, other.employeeId, await tpl(f), "2026-10-01", null),
      ).rejects.toMatchObject({ code: "TK002" });
    });
  });

  describe("shift overrides (PRD 23.1)", () => {
    const tpl = async (f: Fixture) =>
      (
        await client.query<{ id: string }>(
          "INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES ($1, $2, '20:00', 720) RETURNING id",
          [f.tenantId, `t-${Math.random()}`],
        )
      ).rows[0]!.id;
    const override = (f: Fixture, date: string, kind: string, templateId: string | null) =>
      client.query(
        "INSERT INTO shift_override (tenant_id, employee_id, work_date, kind, template_id) VALUES ($1, $2, $3, $4, $5)",
        [f.tenantId, f.employeeId, date, kind, templateId],
      );

    it("ADD and SWAP name a template, REMOVE does not; one override per employee and date", async () => {
      const f = await setup();
      const t = await tpl(f);
      await override(f, "2026-11-01", "ADD", t);
      await override(f, "2026-11-02", "SWAP", t);
      await override(f, "2026-11-03", "REMOVE", null);
      await expect(override(f, "2026-11-04", "ADD", null)).rejects.toMatchObject({ code: CHECK });
      await expect(override(f, "2026-11-04", "REMOVE", t)).rejects.toMatchObject({ code: CHECK });
      await expect(override(f, "2026-11-04", "MOVE", t)).rejects.toMatchObject({ code: CHECK });
      await expect(override(f, "2026-11-01", "REMOVE", null)).rejects.toMatchObject({
        code: UNIQUE,
      });
    });
  });

  // ---------------------------------------------------------------- isolation

  describe("tenant isolation", () => {
    it("the runtime role sees only its own tenant's schedule data", async () => {
      const a = await setup();
      const b = await setup();
      for (const f of [a, b]) {
        await client.query(
          "INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES ($1, 'Шөнө', '20:00', 720)",
          [f.tenantId],
        );
        await tx(client, async () => {
          await client.query(
            "INSERT INTO holiday (tenant_id, name, from_date, to_date) VALUES ($1, 'H', '2026-01-01', '2026-01-01')",
            [f.tenantId],
          );
        });
        await client.query(
          "INSERT INTO attendance_rule_version (tenant_id, valid_from) VALUES ($1, '2026-01-01')",
          [f.tenantId],
        );
      }
      for (const table of ["shift_template", "holiday", "attendance_rule_version"]) {
        const rows = await asTenant(
          client,
          a.tenantId,
          async () => (await client.query(`SELECT tenant_id FROM ${table}`)).rows,
        );
        expect(rows).toEqual([{ tenant_id: a.tenantId }]);
      }
      await expect(
        asTenant(client, a.tenantId, () =>
          client.query(
            "INSERT INTO holiday (tenant_id, name, from_date, to_date) VALUES ($1, 'X', '2026-02-01', '2026-02-01')",
            [b.tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });
});
