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

const BOM = String.fromCharCode(0xfeff);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe.skipIf(!hasDb)("holiday import from Excel / CSV (PRD 14.2, 12.3)", () => {
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
    const loc = async (name: string) =>
      (await post(admin, "/v1/locations", { name, lat: 47.9, lng: 106.9, radiusM: 150 })).body
        .id as string;
    return { tenant, admin, hr, central: await loc("Төв салбар"), emma: await loc("ЭМАА") };
  }

  const upload = (token: string, query: string, body: Buffer | string, type = "text/csv") =>
    h
      .http()
      .post(`/v1/holidays/import${query}`)
      .set(bearer(token))
      .set("Content-Type", type)
      .send(body as never);

  async function xlsx(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Баяр");
    rows.forEach((r) => sheet.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const future = (n: number) => addDays(today(), 30 + n);
  const header = "Нэр,Эхлэх,Дуусах,Төрөл,Салбар,Жил бүр";

  it("a dry run reports every row and writes nothing", async () => {
    const w = await world();
    const csv = [
      header,
      `Шинэ жил,${future(0)},${future(0)},PUBLIC_HOLIDAY,all,yes`,
      `Компанийн ой,${future(5)},${future(6)},Компанийн амралт,"Төв салбар, ЭМАА",үгүй`,
      `,${future(7)},,,,`,
      `Буруу огноо,2026-02-30,,,,`,
      `Салбаргүй,${future(8)},,,Байхгүй салбар,`,
      `Хугацаа буруу,${future(10)},${future(9)},,,`,
      `Шинэ жил,${future(0)},,,,`,
      `Өчигдөр,${addDays(today(), -1)},,,,`,
    ].join("\n");
    const res = await upload(w.admin, "", csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, committed: false });
    expect(res.body.summary).toEqual({ total: 8, ok: 2, warnings: 0, errors: 6, created: 0 });
    const byRow = Object.fromEntries(res.body.rows.map((r: { row: number }) => [r.row, r]));
    expect(byRow[2]).toMatchObject({
      status: "OK",
      data: { name: "Шинэ жил", kind: "PUBLIC_HOLIDAY", appliesToAll: true, repeatsYearly: true },
    });
    expect(byRow[3].data).toMatchObject({
      kind: "COMPANY_DAY_OFF",
      appliesToAll: false,
      repeatsYearly: false,
    });
    expect(byRow[3].data.locationIds.sort()).toEqual([w.central, w.emma].sort());
    expect(byRow[4].messages[0].code).toBe("NAME_REQUIRED");
    expect(byRow[5].messages[0].code).toBe("FROM_INVALID");
    expect(byRow[6].messages[0].code).toBe("LOCATION_NOT_FOUND");
    expect(byRow[7].messages[0].code).toBe("DATES_REVERSED");
    expect(byRow[8].messages[0].code).toBe("DUPLICATE_IN_FILE");
    expect(byRow[9].messages[0].code).toBe("RECOMPUTE_CONFIRMATION_REQUIRED");
    expect((await get(w.hr, "/v1/holidays")).body).toEqual([]);
  });

  it("imports valid rows only, skips existing ones, and is idempotent", async () => {
    const w = await world();
    await post(w.admin, "/v1/holidays", {
      name: "Байгаа",
      fromDate: future(20),
      toDate: future(20),
    });
    const csv = [
      header,
      `Шинэ,${future(0)},,,,`,
      `Байгаа,${future(20)},,,,`,
      `Алдаатай,xx,,,,`,
    ].join("\n");
    const done = await upload(w.admin, "?dryRun=false&fileName=baiyal.csv", csv);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      dryRun: false,
      committed: true,
      summary: { total: 3, ok: 1, warnings: 1, errors: 1, created: 1 },
    });
    expect(done.body.rows[1]).toMatchObject({
      status: "WARNING",
      messages: [expect.objectContaining({ code: "ALREADY_EXISTS" })],
    });
    expect((await get(w.hr, "/v1/holidays")).body.map((x: { name: string }) => x.name)).toEqual([
      "Шинэ",
      "Байгаа",
    ]);
    // the same file again changes nothing
    const again = await upload(w.admin, "?dryRun=false", csv);
    expect(again.body.summary).toMatchObject({ ok: 0, warnings: 2, created: 0 });
    expect((await get(w.hr, "/v1/holidays")).body).toHaveLength(2);
    expect(await auditActions(h, w.tenant.id)).toContain("holiday.imported");
  });

  it("abort-on-error imports nothing when any row is bad", async () => {
    const w = await world();
    const csv = [header, `Сайн,${future(0)},,,,`, `Муу,xx,,,,`].join("\n");
    const res = await upload(w.admin, "?dryRun=false&mode=ABORT_ON_ERROR", csv);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IMPORT_HAS_ERRORS");
    expect(res.body.report.summary.errors).toBe(1);
    expect((await get(w.hr, "/v1/holidays")).body).toEqual([]);
    expect(
      (
        await upload(
          w.admin,
          "?dryRun=false&mode=ABORT_ON_ERROR",
          [header, `Сайн,${future(0)},,,,`].join("\n"),
        )
      ).body.summary.created,
    ).toBe(1);
  });

  it("reads .xlsx (dates as dates, formulas as their result), English headers and semicolon CSV", async () => {
    const w = await world();
    const d = new Date(`${future(0)}T00:00:00Z`);
    const book = await xlsx([
      ["Name", "From", "To", "Type", "Locations", "Repeats yearly"],
      ["Excel баяр", d, d, "COMPANY_DAY_OFF", "ЭМАА", "yes"],
    ]);
    const res = await upload(w.admin, "?dryRun=false", book, XLSX);
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(1);
    const stored = (await get(w.hr, "/v1/holidays")).body[0];
    expect(stored).toMatchObject({
      name: "Excel баяр",
      fromDate: future(0),
      kind: "COMPANY_DAY_OFF",
      repeatsYearly: true,
      appliesToAll: false,
      locationIds: [w.emma],
    });

    const semi = `Нэр;Эхлэх\nТочка таслал;${future(3)}`;
    expect((await upload(w.admin, "?dryRun=false", semi)).body.summary.created).toBe(1);
    // a leading BOM (what Excel writes) is fine
    expect(
      (await upload(w.admin, "", `${BOM}${header}\nBOM,${future(4)},,,,`)).body.summary.ok,
    ).toBe(1);
  });

  it("treats formula-looking cells as text and never evaluates them", async () => {
    const w = await world();
    const book = await xlsx([
      ["Нэр", "Эхлэх"],
      ['=HYPERLINK("http://x","x")', future(0)],
      ["+cmd|' /C calc'!A0", future(1)],
    ]);
    const res = await upload(w.admin, "?dryRun=false", book, XLSX);
    expect(res.body.summary.created).toBe(2);
    const names = (await get(w.hr, "/v1/holidays")).body.map((x: { name: string }) => x.name);
    expect(names).toEqual(['=HYPERLINK("http://x","x")', "+cmd|' /C calc'!A0"]);
    // and a CSV export of them is neutralized
    const csv = await get(w.admin, `/v1/exports/holidays?format=csv&year=${future(0).slice(0, 4)}`);
    expect(csv.text).toContain("'=HYPERLINK");
    expect(csv.text).toContain("'+cmd");
  });

  it("confirmRecompute lets past dates in; limits and bad files are rejected", async () => {
    const w = await world();
    const past = [header, `Өчигдөр,${addDays(today(), -1)},,,,`].join("\n");
    expect((await upload(w.admin, "?dryRun=false", past)).body.summary).toMatchObject({
      errors: 1,
      created: 0,
    });
    expect(
      (await upload(w.admin, "?dryRun=false&confirmRecompute=true", past)).body.summary,
    ).toMatchObject({ created: 1 });

    const many = [
      header,
      ...Array.from({ length: 2001 }, (_, i) => `H${i},${future(i % 300)},,,,`),
    ].join("\n");
    const tooMany = await upload(w.admin, "", many);
    expect(tooMany.status).toBe(413);
    expect(tooMany.body.code).toBe("TOO_MANY_ROWS");
    expect((await upload(w.admin, "", "Нэр\nХоосон")).body.code).toBe("FILE_COLUMNS_MISSING");
    expect((await upload(w.admin, "", "")).status).toBe(415);
    expect(
      (await upload(w.admin, "", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), XLSX)).body.code,
    ).toBe("FILE_UNREADABLE");
    expect(
      (await upload(w.admin, "", Buffer.from([0x00, 0x01, 0x02]), "application/octet-stream"))
        .status,
    ).toBe(400);
    expect((await upload(w.admin, "?mode=OTHER", header)).status).toBe(400);
    expect(
      (await h.http().post("/v1/holidays/import").set("Content-Type", "text/csv").send(header))
        .status,
    ).toBe(401);
    expect((await upload(w.hr, "", header)).status).toBe(403);
  });

  it("serves a template that imports cleanly", async () => {
    const w = await world();
    const csv = await get(w.admin, "/v1/holidays/import/template?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("Нэр,Эхлэх,Дуусах,Төрөл,Салбар,Жил бүр");
    // the example rows are in 2027; make sure they import (the "Төв салбар, ЭМАА" row needs those locations)
    const res = await upload(w.admin, "?confirmRecompute=true", csv.text);
    expect(res.body.summary).toMatchObject({ total: 2, errors: 0 });
    const book = await get(w.admin, "/v1/holidays/import/template")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(book.headers["content-type"]).toContain("spreadsheetml");
    expect((book.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect((await get(w.hr, "/v1/holidays/import/template")).status).toBe(403);
  });
});
