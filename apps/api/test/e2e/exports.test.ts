import ExcelJS from "exceljs";
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

describe.skipIf(!hasDb)("report export (PRD 20)", () => {
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

  /** Downloads a binary export. */
  const download = (token: string, url: string) =>
    h
      .http()
      .get(url)
      .set(bearer(token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

  async function sheetRows(body: Buffer): Promise<string[][]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    const rows: string[][] = [];
    wb.worksheets[0]!.eachRow((row) =>
      rows.push(
        (row.values as unknown[])
          .slice(1)
          .map((v) => (v === null || v === undefined ? "" : String(v))),
      ),
    );
    return rows;
  }

  async function world() {
    const tenant = await createTenant(h);
    await h.owner.query("UPDATE tenant SET name = 'Тест байгууллага' WHERE id = $1", [tenant.id]);
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
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    const central = await loc("Төв салбар");
    const emma = await loc("ЭМАА");
    const employee = async (no: string, location = central, extra: object = {}) =>
      relabel(
        await post(hr, "/v1/employees", {
          lastName: "Овог",
          firstName: no,
          departmentId: dept,
          primaryLocationId: location,
          ...extra,
        }),
        no,
      );
    return { tenant, admin, hr, mgr, mgrUser, dept, central, emma, employee };
  }

  it("exports the same list as Excel, CSV and PDF with the right headers and content types", async () => {
    const w = await world();
    await w.employee("E-1", w.central, { rank: "Ахмад" });
    await w.employee("E-2", w.emma);

    const xlsx = await download(w.hr, "/v1/exports/employees?format=xlsx");
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.headers["content-disposition"]).toMatch(
      /attachment; filename="employees_\d{4}-\d{2}-\d{2}\.xlsx"/u,
    );
    const rows = await sheetRows(xlsx.body as Buffer);
    expect(rows[0]).toEqual(
      expect.arrayContaining(["Код", "Овог", "Нэр", "Салбар", "Цол", "Албан тушаал"]),
    );
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(
      expect.arrayContaining(["E-1", "Овог", "E-1", "Хамгаалалт", "Төв салбар", "Ахмад"]),
    );

    const csv = await h.http().get("/v1/exports/employees?format=csv").set(bearer(w.hr));
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(csv.text).toContain("Овог,E-2");

    const pdf = await download(w.hr, "/v1/exports/employees?format=pdf");
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    // default format is Excel
    expect((await download(w.hr, "/v1/exports/employees")).headers["content-type"]).toContain(
      "spreadsheetml",
    );
  });

  it("applies the screen filters and keeps the data scope", async () => {
    const w = await world();
    await w.employee("E-1", w.central);
    await w.employee("E-2", w.emma, { scheduleMode: "SHIFT" });
    const byLocation = await h
      .http()
      .get(`/v1/exports/employees?format=csv&locationId=${w.emma}`)
      .set(bearer(w.hr));
    expect(byLocation.text).toContain("E-2");
    expect(byLocation.text).not.toContain("E-1");
    expect(
      (await h.http().get("/v1/exports/employees?format=csv&scheduleMode=SHIFT").set(bearer(w.hr)))
        .text,
    ).not.toContain("E-1");
    expect(
      (await h.http().get("/v1/exports/employees?format=csv&q=E-1").set(bearer(w.hr))).text,
    ).not.toContain("E-2");
    // an HR user with a scope exports only that scope
    const scoped = await createUser(h, w.tenant, { username: "hr2", role: "HR", totp: true });
    const scopedToken = (await signIn(h, scoped)).accessToken;
    await put(w.admin, `/v1/users/${scoped.id}/scope`, {
      locationIds: [w.emma],
      departmentIds: [],
    });
    const own = await h.http().get("/v1/exports/employees?format=csv").set(bearer(scopedToken));
    expect(own.text).toContain("E-2");
    expect(own.text).not.toContain("E-1");
  });

  it("a Manager cannot export unless the Org Admin allows it, and then only inside their scope", async () => {
    const w = await world();
    await w.employee("E-1", w.central);
    await w.employee("E-2", w.emma);
    const denied = await h.http().get("/v1/exports/employees?format=csv").set(bearer(w.mgr));
    expect(denied.status).toBe(403);
    await h.owner.query(
      "INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, 'manager_may_export', 'true')",
      [w.tenant.id],
    );
    await put(w.admin, `/v1/users/${w.mgrUser.id}/scope`, {
      locationIds: [w.emma],
      departmentIds: [],
    });
    const allowed = await h.http().get("/v1/exports/employees?format=csv").set(bearer(w.mgr));
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain("E-2");
    expect(allowed.text).not.toContain("E-1");
    expect((await h.http().get("/v1/exports/employees?format=csv")).status).toBe(401);
  });

  it("every export is audited with the report, format, filters and row count", async () => {
    const w = await world();
    await w.employee("E-1");
    await h
      .http()
      .get(`/v1/exports/employees?format=csv&locationId=${w.central}`)
      .set(bearer(w.hr));
    expect(await auditActions(h, w.tenant.id)).toContain("report.exported");
    const { rows } = await h.owner.query(
      "SELECT actor_role, after FROM audit_log WHERE tenant_id = $1 AND action = 'report.exported'",
      [w.tenant.id],
    );
    expect(rows[0].actor_role).toBe("HR");
    expect(rows[0].after).toMatchObject({
      report: "employees",
      format: "csv",
      rows: 1,
      filters: { locationId: w.central },
    });
  });

  it("exports the reason report and the reason assignments", async () => {
    const w = await world();
    const [a, b] = [await w.employee("E-1"), await w.employee("E-2")];
    const reasons = (await h.http().get("/v1/reasons").set(bearer(w.hr))).body as Array<{
      id: string;
      name: string;
    }>;
    const training = reasons.find((r) => r.name === "Сургалттай")!.id;
    await post(w.hr, "/v1/reason-assignments", {
      employeeIds: [a, b],
      reasonId: training,
      fromDate: "2026-10-06",
      toDate: "2026-10-15",
      description: "Аюулгүй ажиллагаа",
    });
    const report = await download(
      w.hr,
      "/v1/exports/reason-report?format=xlsx&from=2026-10-01&to=2026-10-31",
    );
    const rows = await sheetRows(report.body as Buffer);
    expect(rows[0]).toEqual(["Шалтгаан", "Ажилтан (давхцалгүй)", "Ажилтан-өдөр"]);
    expect(rows.find((r) => r[0] === "Сургалттай")).toEqual(["Сургалттай", "2", "20"]);
    expect(rows).toHaveLength(16); // header + 15 reasons
    const list = await h
      .http()
      .get("/v1/exports/reason-assignments?format=csv&from=2026-10-01&to=2026-10-31")
      .set(bearer(w.hr));
    expect(list.text).toContain("Аюулгүй ажиллагаа");
    expect(list.text.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(
      (
        await h
          .http()
          .get("/v1/exports/reason-report?format=csv&from=2026-10-31&to=2026-10-01")
          .set(bearer(w.hr))
      ).status,
    ).toBe(400);
    expect(
      (await h.http().get("/v1/exports/reason-report?format=csv").set(bearer(w.hr))).status,
    ).toBe(400);
  });

  it("exports holidays, shift assignments and the roster calendar", async () => {
    const w = await world();
    await put(w.admin, "/v1/working-week", {
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
        weekday <= 5
          ? { weekday, working: true, start: "08:30", end: "17:30" }
          : { weekday, working: false },
      ),
    });
    const holiday = addDays(today(), 2);
    await post(w.admin, "/v1/holidays", {
      name: "Хөдөлмөрийн баяр",
      fromDate: holiday,
      toDate: holiday,
      appliesToAll: false,
      locationIds: [w.emma],
    });
    const hol = await h
      .http()
      .get(`/v1/exports/holidays?format=csv&year=${holiday.slice(0, 4)}`)
      .set(bearer(w.hr));
    expect(hol.text).toContain("Хөдөлмөрийн баяр");
    expect(hol.text).toContain("ЭМАА");
    expect(hol.text).toContain("Нийтийн баяр");

    const night = (
      await post(w.admin, "/v1/shift-templates", {
        name: "Шөнө",
        startTime: "20:00",
        endTime: "08:00",
      })
    ).body.id as string;
    const guard = await w.employee("G-1", w.central, { scheduleMode: "SHIFT" });
    await post(w.hr, "/v1/shift-assignments", {
      items: [{ employeeId: guard }],
      templateId: night,
      fromDate: today(),
    });
    const assignments = await h
      .http()
      .get("/v1/exports/shift-assignments?format=csv")
      .set(bearer(w.hr));
    expect(assignments.text).toContain("G-1");
    expect(assignments.text).toContain("Шөнө");

    const roster = await download(
      w.hr,
      `/v1/exports/shift-roster?format=xlsx&from=${today()}&to=${addDays(today(), 3)}&scheduleMode=SHIFT`,
    );
    const rows = await sheetRows(roster.body as Buffer);
    expect(rows[0]).toHaveLength(2 + 4 + 1);
    expect(rows[0]![2]).toBe(today().slice(5));
    expect(rows[1]!.slice(0, 2)).toEqual(["G-1", "Овог G-1"]);
    expect(rows[1]![2]).toBe("20:00-08:00+1");
    const pdf = await download(
      w.hr,
      `/v1/exports/shift-roster?format=pdf&from=${today()}&to=${addDays(today(), 13)}`,
    );
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects unknown reports, formats and fields; a PDF with many rows paginates", async () => {
    const w = await world();
    expect((await h.http().get("/v1/exports/nothing").set(bearer(w.hr))).status).toBe(404);
    expect((await h.http().get("/v1/exports/constructor").set(bearer(w.hr))).status).toBe(404);
    expect((await h.http().get("/v1/exports/employees?format=docx").set(bearer(w.hr))).status).toBe(
      400,
    );
    expect(
      (await h.http().get("/v1/exports/employees?locationId=abc").set(bearer(w.hr))).status,
    ).toBe(400);
    expect(
      (await h.http().get("/v1/exports/shift-roster?format=csv").set(bearer(w.hr))).status,
    ).toBe(400);
    for (let i = 0; i < 60; i++) await w.employee(`P-${String(i).padStart(3, "0")}`);
    const pdf = await download(w.hr, "/v1/exports/employees?format=pdf");
    const pages = (pdf.body as Buffer).toString("latin1").match(/\/Type \/Page\b/gu) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});
