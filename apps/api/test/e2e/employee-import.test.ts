import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createTenant,
  createUser,
  type Harness,
  login,
  signIn,
  startHarness,
} from "./harness";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEADER = "Код,Овог,Нэр,Нэгж,Салбар,Цол,Албан тушаал,Ажилд орсон,Хуваарь,Гараар ирц";

describe.skipIf(!hasDb)("employee import from Excel / CSV (PRD 12.3)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (token: string, url: string, body: object = {}) =>
    h.http().post(url).set(bearer(token)).send(body);
  const get = (token: string, url: string) => h.http().get(url).set(bearer(token));
  const upload = (token: string, query: string, body: Buffer | string, type = "text/csv") =>
    h
      .http()
      .post(`/v1/employees/import${query}`)
      .set(bearer(token))
      .set("Content-Type", type)
      .send(body as never);
  const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
  const count = async (tenantId: string) =>
    (
      await h.owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM employee WHERE tenant_id = $1",
        [tenantId],
      )
    ).rows[0]!.n;

  async function world() {
    const tenant = await createTenant(h);
    const adminUser = await createUser(h, tenant, {
      username: "admin",
      role: "ORG_ADMIN",
      totp: true,
    });
    const admin = (await signIn(h, adminUser)).accessToken;
    const hr = (
      await signIn(h, await createUser(h, tenant, { username: "hr", role: "HR", totp: true }))
    ).accessToken;
    const mgr = (await signIn(h, await createUser(h, tenant, { username: "mgr", role: "MANAGER" })))
      .accessToken;
    const dept = async (name: string) =>
      (await post(admin, "/v1/departments", { name })).body.id as string;
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    const warehouse = await dept("Агуулах");
    const guard = await dept("Хамгаалалт");
    const central = await loc("Төв салбар");
    const emma = await loc("ЭМАА");
    return { tenant, adminUser, admin, hr, mgr, warehouse, guard, central, emma };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const someFile = () =>
    csv(
      ",Бат,Болд,Агуулах,Төв салбар,Ахмад,Нярав,2026-01-05,Энгийн,үгүй",
      ",Сараа,Дорж,Хамгаалалт,ЭМАА,,Жолооч,,Ээлжийн,тийм",
    );
  const employeeOf = async (w: W, lastName: string) =>
    (
      await h.owner.query(
        `SELECT e.id, e.employee_no, e.status, e.start_date::text AS start_date, e.schedule_mode, e.manual_attendance, d.name AS department, l.name AS location,
                (SELECT title FROM employee_rank_assignment WHERE employee_id = e.id AND valid_to IS NULL) AS rank,
                (SELECT title FROM employee_position_assignment WHERE employee_id = e.id AND valid_to IS NULL) AS position
           FROM employee e JOIN department d ON d.id = e.department_id JOIN location l ON l.id = e.primary_location_id
          WHERE e.tenant_id = $1 AND e.last_name = $2`,
        [w.tenant.id, lastName],
      )
    ).rows[0];

  it("serves a template with the Mongolian headers (Excel and CSV)", async () => {
    const w = await world();
    const x = await h
      .http()
      .get("/v1/employees/import/template")
      .set(bearer(w.hr))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(x.status).toBe(200);
    expect(x.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as ArrayBuffer);
    expect(wb.worksheets[0]!.getRow(1).values).toEqual(
      expect.arrayContaining(["Код", "Овог", "Нэр", "Нэгж", "Салбар"]),
    );
    const c = await get(w.hr, "/v1/employees/import/template?format=csv");
    expect(c.text).toContain("Овог");
    expect((await get(w.mgr, "/v1/employees/import/template")).status).toBe(403);
  });

  it("a dry run reports every row and writes nothing", async () => {
    const w = await world();
    const res = await upload(
      w.hr,
      "",
      csv(
        ",Бат,Болд,Агуулах,Төв салбар,Ахмад,Нярав,2026-01-05,Энгийн,үгүй",
        ",Сараа,,Хамгаалалт,ЭМАА,,,,,",
        ",Оюун,Цэцэг,Байхгүй нэгж,Төв салбар,,,,,",
        ",Тэмүүлэн,Ганбат,Агуулах,Төв салбар,,,2026-02-30,,",
        ",Наран,Төгс,Агуулах,Төв салбар,,,,Хагас,",
        "123,Билгүүн,Эрдэнэ,Агуулах,Төв салбар,,,,,",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      committed: false,
      summary: { total: 6, ok: 1, errors: 5, created: 0 },
    });
    const codes = res.body.rows.map(
      (r: { messages: Array<{ code: string }> }) => r.messages[0]?.code,
    );
    expect(codes).toEqual([
      undefined,
      "FIRST_NAME_REQUIRED",
      "DEPARTMENT_UNKNOWN",
      "START_DATE_INVALID",
      "SCHEDULE_INVALID",
      "CODE_INVALID",
    ]);
    expect(res.body.rows[0]).toMatchObject({
      row: 2,
      status: "OK",
      action: "CREATE",
      fullName: "Бат Болд",
    });
    expect(await count(w.tenant.id)).toBe(0);
  });

  it("imports the valid rows: codes are assigned, rank, position and the rest are applied, the import is audited", async () => {
    const w = await world();
    const res = await upload(
      w.hr,
      "?dryRun=false&fileName=ажилтнууд.csv",
      someFile() + "\n,Алдаатай,Мөр,Байхгүй,Төв салбар,,,,,",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: false,
      committed: true,
      summary: { ok: 2, errors: 1, created: 2, updated: 0 },
    });
    expect(res.body.rows[0].employeeNo).toMatch(/^\d{16}$/u);
    expect(res.body.rows[2]).toMatchObject({ status: "ERROR", action: null });
    expect(await count(w.tenant.id)).toBe(2);
    expect(await employeeOf(w, "Бат")).toMatchObject({
      employee_no: res.body.rows[0].employeeNo,
      department: "Агуулах",
      location: "Төв салбар",
      rank: "Ахмад",
      position: "Нярав",
      start_date: "2026-01-05",
      schedule_mode: "STANDARD",
      manual_attendance: false,
    });
    expect(await employeeOf(w, "Сараа")).toMatchObject({
      schedule_mode: "SHIFT",
      manual_attendance: true,
      rank: null,
      position: "Жолооч",
    });
    expect(await auditActions(h, w.tenant.id)).toEqual(
      expect.arrayContaining(["employee.imported", "employee.created"]),
    );
    const audit = await h.owner.query(
      "SELECT after FROM audit_log WHERE tenant_id = $1 AND action = 'employee.imported'",
      [w.tenant.id],
    );
    expect(audit.rows[0].after).toMatchObject({ fileName: "ажилтнууд.csv", created: 2, errors: 1 });
    expect(JSON.stringify(audit.rows[0].after)).not.toContain("Бат");
  });

  it("abort-on-error imports nothing when any row is wrong", async () => {
    const w = await world();
    const res = await upload(
      w.hr,
      "?dryRun=false&mode=ABORT_ON_ERROR",
      someFile() + "\n,Алдаатай,Мөр,Байхгүй,Төв салбар,,,,,",
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_HAS_ERRORS");
    expect(res.body.report.summary.errors).toBe(1);
    expect(await count(w.tenant.id)).toBe(0);
  });

  it("uploading the same file again does not create duplicates; duplicates can be allowed on purpose", async () => {
    const w = await world();
    await upload(w.hr, "?dryRun=false", someFile());
    const again = await upload(w.hr, "?dryRun=false", someFile());
    expect(again.body.summary).toMatchObject({ ok: 0, warnings: 2, created: 0 });
    expect(again.body.rows[0].messages[0].code).toBe("ALREADY_EXISTS");
    expect(await count(w.tenant.id)).toBe(2);
    // two namesakes in one file: the second is skipped...
    const twins = csv(",Гэрэл,Ану,Агуулах,Төв салбар,,,,,", ",Гэрэл,Ану,Агуулах,Төв салбар,,,,,");
    const skipped = await upload(w.hr, "?dryRun=false", twins);
    expect(
      skipped.body.rows.map((r: { messages: Array<{ code: string }> }) => r.messages[0]?.code),
    ).toEqual([undefined, "DUPLICATE_IN_FILE"]);
    // ...unless HR says they really are two people
    const both = await upload(w.hr, "?dryRun=false&onDuplicate=CREATE", twins);
    expect(both.body.summary.created).toBe(2);
    expect(await count(w.tenant.id)).toBe(5);
  });

  it("a row with an existing code updates that employee: dry run shows the diff, blank optional cells change nothing", async () => {
    const w = await world();
    const first = await upload(w.hr, "?dryRun=false", someFile());
    const [bat, saraa] = first.body.rows.map(
      (r: { employeeNo: string }) => r.employeeNo,
    ) as string[];
    const edit = csv(
      `${bat},Бат,Болдбаатар,Хамгаалалт,ЭМАА,Хошууч,,,,`,
      `${saraa},Сараа,Дорж,Хамгаалалт,ЭМАА,,Жолооч,,Ээлжийн,тийм`,
    );
    const dry = await upload(w.hr, "", edit);
    expect(dry.body.summary).toMatchObject({ ok: 1, warnings: 1 });
    expect(dry.body.rows[0]).toMatchObject({ action: "UPDATE", employeeNo: bat });
    expect(dry.body.rows[0].changes).toEqual([
      { field: "firstName", from: "Болд", to: "Болдбаатар" },
      { field: "department", from: "Агуулах", to: "Хамгаалалт" },
      { field: "location", from: "Төв салбар", to: "ЭМАА" },
      { field: "rank", from: "Ахмад", to: "Хошууч" },
    ]);
    expect(dry.body.rows[1].messages[0].code).toBe("NO_CHANGES");
    expect((await employeeOf(w, "Бат")).department).toBe("Агуулах"); // dry run changed nothing

    const done = await upload(w.hr, "?dryRun=false", edit);
    expect(done.body.summary).toMatchObject({ updated: 1, created: 0 });
    expect(await employeeOf(w, "Бат")).toMatchObject({
      department: "Хамгаалалт",
      location: "ЭМАА",
      rank: "Хошууч",
      position: "Нярав", // the blank cell left it alone
      start_date: "2026-01-05",
      schedule_mode: "STANDARD",
    });
    expect(await count(w.tenant.id)).toBe(2);
  });

  it("code problems are errors: unknown, twice in the file, disabled, archived", async () => {
    const w = await world();
    const first = await upload(w.hr, "?dryRun=false", someFile());
    const [bat, saraa] = first.body.rows.map(
      (r: { employeeNo: string }) => r.employeeNo,
    ) as string[];
    await post(w.hr, `/v1/employees/${(await employeeOf(w, "Сараа")).id}/disable`, {});
    await h.owner.query(
      "UPDATE employee SET status = 'ARCHIVED' WHERE employee_no = $1 AND tenant_id = $2",
      [bat, w.tenant.id],
    );
    const res = await upload(
      w.hr,
      "",
      csv(
        `9999999999999999,Бат,Болд,Агуулах,Төв салбар,,,,,`,
        `${saraa},Сараа,Дорж,Агуулах,Төв салбар,,,,,`,
        `${saraa},Сараа,Дорж,Агуулах,Төв салбар,,,,,`,
        `${bat},Бат,Болд,Агуулах,Төв салбар,,,,,`,
      ),
    );
    expect(
      res.body.rows.map((r: { messages: Array<{ code: string }> }) => r.messages[0]?.code),
    ).toEqual([
      "CODE_NOT_FOUND",
      "EMPLOYEE_NOT_ACTIVE",
      "CODE_DUPLICATE_IN_FILE",
      "EMPLOYEE_ARCHIVED",
    ]);
  });

  it("createAccounts gives each new employee a login; the one-time passwords are returned once and work", async () => {
    const w = await world();
    const res = await upload(w.hr, "?dryRun=false&createAccounts=true", someFile());
    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(2);
    const [c] = res.body.credentials as Array<{
      employeeNo: string;
      username: string;
      temporaryPassword: string;
    }>;
    expect(c!.username).toBe(c!.employeeNo); // the default login name is the 16-digit code
    const signedIn = await login(h, {
      orgCode: w.tenant.code,
      username: c!.username,
      password: c!.temporaryPassword,
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.tokens.requires).toContain("PASSWORD_CHANGE");
    // never in the audit log, and a dry run or a plain import returns none
    const audit = await h.owner.query(
      "SELECT after::text AS text FROM audit_log WHERE tenant_id = $1",
      [w.tenant.id],
    );
    expect(audit.rows.some((r) => r.text.includes(c!.temporaryPassword))).toBe(false);
    expect(
      (await upload(w.hr, "?createAccounts=true", someFile())).body.credentials,
    ).toBeUndefined();
    expect(
      (await upload(w.hr, "?dryRun=false", csv(",Нэмэлт,Хүн,Агуулах,Төв салбар,,,,,"))).body
        .credentials,
    ).toBeUndefined();
  });

  it("an HR user with a data scope can import only inside it; Managers and Employees cannot import", async () => {
    const w = await world();
    const scoped = await createUser(h, w.tenant, { username: "hr2", role: "HR", totp: true });
    await h.owner.query(
      "INSERT INTO user_scope (tenant_id, user_id, location_id) VALUES ($1, $2, $3)",
      [w.tenant.id, scoped.id, w.central],
    );
    const token = (await signIn(h, scoped)).accessToken;
    const res = await upload(token, "", someFile());
    expect(res.body.rows.map((r: { status: string }) => r.status)).toEqual(["OK", "ERROR"]);
    expect(res.body.rows[1].messages[0].code).toBe("OUT_OF_SCOPE");
    expect((await upload(w.mgr, "", someFile())).status).toBe(403);
  });

  it("reads .xlsx, treats formulas as text, and rejects a file without the required columns or without a body", async () => {
    const w = await world();
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Ажилтнууд");
    sheet.addRow(["Овог", "Нэр", "Нэгж", "Салбар", "Ажилд орсон"]);
    sheet.addRow(["=1+1", "@SUM(A1)", "Агуулах", "Төв салбар", "2026-03-01"]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(w.hr, "?dryRun=false", buffer, XLSX);
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(1);
    const stored = await h.owner.query(
      "SELECT last_name, first_name FROM employee WHERE tenant_id = $1",
      [w.tenant.id],
    );
    expect(stored.rows[0]).toEqual({ last_name: "=1+1", first_name: "@SUM(A1)" }); // text, never evaluated

    const noColumns = await upload(w.hr, "", "Овог,Нэр\nБат,Болд");
    expect(noColumns.status).toBe(400);
    expect(noColumns.body.code).toBe("FILE_COLUMNS_MISSING");
    expect((await h.http().post("/v1/employees/import").set(bearer(w.hr)).send({})).status).toBe(
      415,
    );
  });

  it("the commit is atomic: if one write fails, none of the rows is kept", async () => {
    const w = await world();
    // A trigger that fails for one name makes the second insert blow up after the first succeeded.
    await h.owner.query(`
      CREATE OR REPLACE FUNCTION tk_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.last_name = 'Хор' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
      DROP TRIGGER IF EXISTS tk_test_fail ON employee;
      CREATE TRIGGER tk_test_fail BEFORE INSERT ON employee FOR EACH ROW EXECUTE FUNCTION tk_test_fail();`);
    try {
      const res = await upload(
        w.hr,
        "?dryRun=false",
        csv(",Сайн,Хүн,Агуулах,Төв салбар,,,,,", ",Хор,Хүн,Агуулах,Төв салбар,,,,,"),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await count(w.tenant.id)).toBe(0);
    } finally {
      await h.owner.query(
        "DROP TRIGGER IF EXISTS tk_test_fail ON employee; DROP FUNCTION IF EXISTS tk_test_fail();",
      );
    }
  });
});
