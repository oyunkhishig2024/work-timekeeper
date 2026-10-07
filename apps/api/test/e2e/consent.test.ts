import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsentService, detectScanType } from "../../src/consent/consent.service";
import { hasDb } from "../db/helpers";
import {
  auditActions,
  bearer,
  createConsentText,
  createEmployee,
  createEmployeeWithUser,
  createUser,
  type Harness,
  SAMPLE_CONSENT_BODY,
  setupWorld,
  signIn,
  startHarness,
} from "./harness";

function pdfText(pdf: Buffer): string | null {
  const dir = mkdtempSync(join(tmpdir(), "tk-pdf-"));
  const file = join(dir, "forms.pdf");
  writeFileSync(file, pdf);
  const out = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
  return out.error ? null : out.stdout;
}
const pageCount = (pdf: Buffer): number =>
  (pdf.toString("latin1").match(/\/Type \/Page\b(?!s)/gu) ?? []).length;

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

describe.skipIf(!hasDb)("consent (PRD 15.4)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const today = () => h.clock.now().toISOString().slice(0, 10);
  const print = (token: string, employeeIds: string[]) =>
    h
      .http()
      .post("/v1/consent/print")
      .set(bearer(token))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .send({ employeeIds });
  const records = async (employeeId: string) =>
    (
      await h.owner.query(
        "SELECT form_code, status, text_version FROM consent_record WHERE employee_id = $1 ORDER BY created_at",
        [employeeId],
      )
    ).rows;
  const markSigned = (token: string, formCode: string, signedOn = today()) =>
    h
      .http()
      .post("/v1/consent/records/mark-signed")
      .set(bearer(token))
      .send({ formCode, signedOn });

  describe("consent texts", () => {
    it("only an Org Admin creates and activates texts; exactly one is active", async () => {
      const w = await setupWorld(h);
      const body = { version: "v2", body: SAMPLE_CONSENT_BODY, isDraft: false };
      expect(
        (await h.http().post("/v1/consent/texts").set(bearer(w.hrTokens.accessToken)).send(body))
          .status,
      ).toBe(403);

      const created = await h
        .http()
        .post("/v1/consent/texts")
        .set(bearer(w.adminTokens.accessToken))
        .send(body);
      expect(created.status).toBe(201);
      expect(
        (await h.http().post("/v1/consent/texts").set(bearer(w.adminTokens.accessToken)).send(body))
          .body.code,
      ).toBe("CONSENT_TEXT_VERSION_EXISTS");
      expect(
        (
          await h
            .http()
            .post("/v1/consent/texts")
            .set(bearer(w.adminTokens.accessToken))
            .send({ ...body, version: "bad version!", body: "short" })
        ).status,
      ).toBe(400);

      expect(
        (
          await h
            .http()
            .post(`/v1/consent/texts/${created.body.id}/activate`)
            .set(bearer(w.adminTokens.accessToken))
        ).status,
      ).toBe(200);
      const list = await h.http().get("/v1/consent/texts").set(bearer(w.hrTokens.accessToken));
      expect(
        list.body
          .filter((t: { active: boolean }) => t.active)
          .map((t: { version: string }) => t.version),
      ).toEqual(["v2"]);
      expect(
        (
          await h
            .http()
            .post("/v1/consent/texts/00000000-0000-4000-8000-000000000000/activate")
            .set(bearer(w.adminTokens.accessToken))
        ).status,
      ).toBe(404);
      expect(await auditActions(h, w.tenant.id)).toEqual(
        expect.arrayContaining(["consent_text.created", "consent_text.activated"]),
      );
    });
  });

  describe("printing", () => {
    it("renders a Cyrillic PDF with one page per employee and the form code on it", async () => {
      const w = await setupWorld(h, { consent: false });
      const second = await createEmployee(h, w.tenant, { name: "Өлзийбат Үүрцайх" });
      const res = await print(w.hrTokens.accessToken, [w.employee.id, second.id]);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["x-consent-printed"]).toBe("2");
      expect(res.headers["x-consent-skipped"]).toBe("0");
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pageCount(pdf)).toBe(2);

      const text = pdfText(pdf);
      if (text !== null) {
        expect(text).toContain("Өлзийбат Үүрцайх"); // Mongolian letters Ө and Ү render
        expect(text).toContain(w.employee.name);
        expect(text).toContain("Байршлын мэдээлэл боловсруулах");
        const [first] = await records(w.employee.id);
        expect(text).toContain(first.form_code);
        expect(text).toContain(w.tenant.code); // organization name
      }
      expect((await records(second.id))[0]).toMatchObject({
        status: "PRINTED",
        text_version: "v1",
      });
      expect(await auditActions(h, w.tenant.id)).toContain("consent.printed");
    });

    it("reprinting an unsigned form reuses its code; signed employees are skipped", async () => {
      const w = await setupWorld(h, { consent: false });
      const other = await createEmployee(h, w.tenant);
      await print(w.hrTokens.accessToken, [w.employee.id, other.id]);
      const [before] = await records(w.employee.id);

      const again = await print(w.hrTokens.accessToken, [w.employee.id]);
      expect(again.status).toBe(200);
      expect(await records(w.employee.id)).toHaveLength(1);
      expect((await records(w.employee.id))[0].form_code).toBe(before.form_code);

      expect((await markSigned(w.hrTokens.accessToken, before.form_code)).status).toBe(200);
      const mixed = await print(w.hrTokens.accessToken, [w.employee.id, other.id]);
      expect(mixed.headers["x-consent-printed"]).toBe("1");
      expect(mixed.headers["x-consent-skipped"]).toBe("1");

      const none = await print(w.hrTokens.accessToken, [w.employee.id]);
      expect(none.status).toBe(409);
    });

    it("rejects unknown employees, a missing active text, and non-staff callers", async () => {
      const w = await setupWorld(h, { text: false, consent: false });
      expect((await print(w.hrTokens.accessToken, [w.employee.id])).status).toBe(409);
      await createConsentText(h, w.tenant);
      expect(
        (await print(w.hrTokens.accessToken, ["00000000-0000-4000-8000-000000000000"])).status,
      ).toBe(404);
      expect((await print(w.empTokens.accessToken, [w.employee.id])).status).toBe(403);
      const mgr = await signIn(
        h,
        await createUser(h, w.tenant, { username: "mgr", role: "MANAGER" }),
      );
      expect((await print(mgr.accessToken, [w.employee.id])).status).toBe(403);
      expect((await h.http().post("/v1/consent/print").send({ employeeIds: [] })).status).toBe(401);
      expect(
        (
          await h
            .http()
            .post("/v1/consent/print")
            .set(bearer(w.hrTokens.accessToken))
            .send({ employeeIds: [] })
        ).status,
      ).toBe(400);
    });

    it("marks draft texts on the page and refuses to print them in production", async () => {
      const w = await setupWorld(h, { text: false, consent: false });
      await createConsentText(h, w.tenant, { version: "draft-1", draft: true });
      const res = await print(w.hrTokens.accessToken, [w.employee.id]);
      expect(res.status).toBe(200);
      const text = pdfText(res.body as Buffer);
      if (text !== null) expect(text).toContain("ЖИШЭЭ ХУВИЛБАР");

      const service = h.app.get(ConsentService) as unknown as { config: { NODE_ENV: string } };
      const original = service.config;
      service.config = { ...original, NODE_ENV: "production" };
      try {
        const blocked = await print(w.hrTokens.accessToken, [w.employee.id]);
        expect(blocked.status).toBe(409);
        expect(JSON.parse((blocked.body as Buffer).toString()).code).toBe("CONSENT_TEXT_DRAFT");
      } finally {
        service.config = original as never;
      }
    });

    it("skips inactive employees", async () => {
      const w = await setupWorld(h, { consent: false });
      const gone = await createEmployee(h, w.tenant, { status: "DISABLED" });
      const res = await print(w.hrTokens.accessToken, [w.employee.id, gone.id]);
      expect(res.headers["x-consent-printed"]).toBe("1");
      expect(res.headers["x-consent-skipped"]).toBe("1");
    });
  });

  describe("recording signed forms", () => {
    it("marks a form signed by its code (case-insensitive) and validates the dates", async () => {
      const w = await setupWorld(h, { consent: false });
      await print(w.hrTokens.accessToken, [w.employee.id]);
      const [form] = await records(w.employee.id);

      expect((await markSigned(w.hrTokens.accessToken, "NOPE-NOPE1")).body.code).toBe(
        "FORM_NOT_FOUND",
      );
      expect(
        (await markSigned(w.hrTokens.accessToken, form.form_code, "2099-01-01")).body.code,
      ).toBe("SIGNED_ON_IN_FUTURE");
      expect(
        (await markSigned(w.hrTokens.accessToken, form.form_code, "2020-01-01")).body.code,
      ).toBe("SIGNED_BEFORE_PRINTED");
      expect(
        (
          await h
            .http()
            .post("/v1/consent/records/mark-signed")
            .set(bearer(w.hrTokens.accessToken))
            .send({ formCode: form.form_code, signedOn: "10/06/2026" })
        ).status,
      ).toBe(400);

      const ok = await markSigned(w.hrTokens.accessToken, form.form_code.toLowerCase());
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "SIGNED", employeeId: w.employee.id });
      expect((await markSigned(w.hrTokens.accessToken, form.form_code)).body.code).toBe(
        "FORM_ALREADY_PROCESSED",
      );

      const detail = await h
        .http()
        .get(`/v1/employees/${w.employee.id}/consent`)
        .set(bearer(w.hrTokens.accessToken));
      expect(detail.body).toMatchObject({
        status: "SIGNED",
        signedTextVersion: "v1",
        reconsentRequired: false,
      });
      expect(await auditActions(h, w.tenant.id)).toContain("consent.signed");
    });

    it("lets the employee register a device only after signing is recorded (end to end)", async () => {
      const w = await setupWorld(h, { consent: false });
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const reg = () =>
        h
          .http()
          .post("/v1/devices/register")
          .set(bearer(w.empTokens.accessToken))
          .send({ qrToken: qr.token, platform: "IOS", attestationKeyId: "k-e2e" });
      expect((await reg()).body.code).toBe("CONSENT_REQUIRED");

      await print(w.hrTokens.accessToken, [w.employee.id]);
      const [form] = await records(w.employee.id);
      expect((await reg()).body.code).toBe("CONSENT_REQUIRED"); // printed is not enough
      await markSigned(w.hrTokens.accessToken, form.form_code);
      expect((await reg()).status).toBe(201);
    });

    it("re-consent: a new active text requires a new signature; the old form is superseded", async () => {
      const w = await setupWorld(h, { consent: false });
      await print(w.hrTokens.accessToken, [w.employee.id]);
      await markSigned(w.hrTokens.accessToken, (await records(w.employee.id))[0].form_code);

      const v2 = (
        await h
          .http()
          .post("/v1/consent/texts")
          .set(bearer(w.adminTokens.accessToken))
          .send({ version: "v2", body: SAMPLE_CONSENT_BODY, isDraft: false })
      ).body;
      await h
        .http()
        .post(`/v1/consent/texts/${v2.id}/activate`)
        .set(bearer(w.adminTokens.accessToken));

      const detail = await h
        .http()
        .get(`/v1/employees/${w.employee.id}/consent`)
        .set(bearer(w.hrTokens.accessToken));
      expect(detail.body).toMatchObject({
        status: "SIGNED",
        signedTextVersion: "v1",
        activeTextVersion: "v2",
        reconsentRequired: true,
      });
      const overview = await h
        .http()
        .get("/v1/consent/overview")
        .set(bearer(w.hrTokens.accessToken));
      expect(overview.body.summary.RECONSENT_REQUIRED).toBe(1);

      const reprint = await print(w.hrTokens.accessToken, [w.employee.id]);
      expect(reprint.headers["x-consent-printed"]).toBe("1");
      const rows = await records(w.employee.id);
      expect(
        rows.map((r: { text_version: string; status: string }) => `${r.text_version}:${r.status}`),
      ).toEqual(["v1:SIGNED", "v2:PRINTED"]);
      await markSigned(w.hrTokens.accessToken, rows[1].form_code);
      expect((await records(w.employee.id)).map((r: { status: string }) => r.status)).toEqual([
        "SUPERSEDED",
        "SIGNED",
      ]);
    });
  });

  describe("withdrawal (PRD 15.4)", () => {
    it("disables the device, ends its session and flags manual attendance", async () => {
      const w = await setupWorld(h);
      const qr = (
        await h.http().post("/v1/qr/onboarding").set(bearer(w.hrTokens.accessToken)).send({})
      ).body;
      const reg = await h
        .http()
        .post("/v1/devices/register")
        .set(bearer(w.empTokens.accessToken))
        .send({ qrToken: qr.token, platform: "ANDROID", attestationKeyId: "k-w" });
      expect(reg.status).toBe(201);

      const url = `/v1/employees/${w.employee.id}/consent/withdraw`;
      expect(
        (
          await h
            .http()
            .post(url)
            .set(bearer(w.hrTokens.accessToken))
            .send({ withdrawnOn: "2000-01-01" })
        ).body.code,
      ).toBe("WITHDRAWN_BEFORE_SIGNED");
      const res = await h
        .http()
        .post(url)
        .set(bearer(w.hrTokens.accessToken))
        .send({ withdrawnOn: today(), note: "Бичгээр хүсэлт гаргасан" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "WITHDRAWN",
        deviceDisabled: true,
        manualAttendance: true,
      });

      expect(
        (
          await h.owner.query("SELECT status, disabled_reason FROM device WHERE id = $1", [
            reg.body.deviceId,
          ])
        ).rows[0],
      ).toEqual({ status: "DISABLED", disabled_reason: "CONSENT_WITHDRAWN" });
      expect(
        (
          await h.owner.query("SELECT manual_attendance FROM employee WHERE id = $1", [
            w.employee.id,
          ])
        ).rows[0].manual_attendance,
      ).toBe(true);
      expect(
        (await h.http().get("/v1/devices/me").set(bearer(w.empTokens.accessToken))).status,
      ).toBe(401);
      expect(
        (
          await h
            .http()
            .post(url)
            .set(bearer(w.hrTokens.accessToken))
            .send({ withdrawnOn: today() })
        ).body.code,
      ).toBe("NO_SIGNED_CONSENT");

      const detail = await h
        .http()
        .get(`/v1/employees/${w.employee.id}/consent`)
        .set(bearer(w.hrTokens.accessToken));
      expect(detail.body.status).toBe("WITHDRAWN");
      // They cannot come back without a new signed form.
      const qr2 = (
        await h
          .http()
          .post(`/v1/employees/${w.employee.id}/replacement-qr`)
          .set(bearer(w.hrTokens.accessToken))
          .send({})
      ).body;
      const freshTokens = await signIn(h, w.user);
      const again = await h
        .http()
        .post("/v1/devices/register")
        .set(bearer(freshTokens.accessToken))
        .send({ qrToken: qr2.token, platform: "ANDROID" });
      expect(again.body.code).toBe("CONSENT_REQUIRED");
      expect(await auditActions(h, w.tenant.id)).toContain("consent.withdrawn");
    });
  });

  describe("overview", () => {
    it("counts employees per state and pages through them", async () => {
      const w = await setupWorld(h, { consent: false });
      const e2 = await createEmployee(h, w.tenant);
      await createEmployee(h, w.tenant);
      await print(w.hrTokens.accessToken, [w.employee.id, e2.id]);
      await markSigned(w.hrTokens.accessToken, (await records(w.employee.id))[0].form_code);

      const res = await h.http().get("/v1/consent/overview").set(bearer(w.hrTokens.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.activeTextVersion).toBe("v1");
      expect(res.body.summary).toMatchObject({
        NOT_REQUESTED: 1,
        PRINTED: 1,
        SIGNED: 1,
        WITHDRAWN: 0,
      });
      expect(res.body.employees).toHaveLength(3);

      const signedOnly = await h
        .http()
        .get("/v1/consent/overview?status=SIGNED")
        .set(bearer(w.hrTokens.accessToken));
      expect(signedOnly.body.employees.map((e: { employeeId: string }) => e.employeeId)).toEqual([
        w.employee.id,
      ]);
      const page = await h
        .http()
        .get("/v1/consent/overview?limit=1&offset=1")
        .set(bearer(w.hrTokens.accessToken));
      expect(page.body.employees).toHaveLength(1);
      expect(
        (
          await h
            .http()
            .get("/v1/consent/overview?status=BOGUS")
            .set(bearer(w.hrTokens.accessToken))
        ).status,
      ).toBe(400);
    });
  });

  describe("scans of the signed paper", () => {
    async function signedForm() {
      const w = await setupWorld(h, { consent: false });
      await print(w.hrTokens.accessToken, [w.employee.id]);
      const [form] = await records(w.employee.id);
      const recordId = (
        await h.owner.query("SELECT id FROM consent_record WHERE form_code = $1", [form.form_code])
      ).rows[0].id as string;
      return { w, form, recordId };
    }
    const upload = (token: string, id: string, body: Buffer, type = "application/pdf") =>
      h
        .http()
        .put(`/v1/consent/records/${id}/scan`)
        .set(bearer(token))
        .set("Content-Type", type)
        .send(body);

    it("stores a PDF or image, returns the same bytes and audits viewing", async () => {
      const { w, form, recordId } = await signedForm();
      expect((await upload(w.hrTokens.accessToken, recordId, PDF_BYTES)).body.code).toBe(
        "FORM_NOT_SIGNED",
      );
      await markSigned(w.hrTokens.accessToken, form.form_code);

      const stored = await upload(w.hrTokens.accessToken, recordId, PDF_BYTES);
      expect(stored.status).toBe(200);
      expect(stored.body).toMatchObject({
        bytes: PDF_BYTES.length,
        contentType: "application/pdf",
      });
      const got = await h
        .http()
        .get(`/v1/consent/records/${recordId}/scan`)
        .set(bearer(w.hrTokens.accessToken))
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(got.status).toBe(200);
      expect(got.headers["content-type"]).toBe("application/pdf");
      expect(got.headers["x-content-type-options"]).toBe("nosniff");
      expect((got.body as Buffer).equals(PDF_BYTES)).toBe(true);

      expect(
        (await upload(w.hrTokens.accessToken, recordId, JPEG_BYTES, "image/jpeg")).body.contentType,
      ).toBe("image/jpeg");
      expect(
        (
          await h
            .http()
            .get(`/v1/employees/${w.employee.id}/consent`)
            .set(bearer(w.hrTokens.accessToken))
        ).body.records[0].hasScan,
      ).toBe(true);
      expect(await auditActions(h, w.tenant.id)).toEqual(
        expect.arrayContaining(["consent.scan_uploaded", "consent.scan_viewed"]),
      );
    });

    it("decides the file type from its content, limits size, and restricts access", async () => {
      const { w, form, recordId } = await signedForm();
      await markSigned(w.hrTokens.accessToken, form.form_code);

      expect(
        (await upload(w.hrTokens.accessToken, recordId, Buffer.from("<html>not a pdf</html>"))).body
          .code,
      ).toBe("UNSUPPORTED_FILE_TYPE");
      expect(
        (await upload(w.hrTokens.accessToken, recordId, Buffer.from("plain text"), "text/plain"))
          .status,
      ).toBe(415);
      const big = await upload(
        w.hrTokens.accessToken,
        recordId,
        Buffer.concat([PDF_BYTES, Buffer.alloc(11 * 1024 * 1024)]),
      );
      expect(big.status).toBe(413);
      expect(big.body.code).toBe("PAYLOAD_TOO_LARGE");

      expect((await upload(w.empTokens.accessToken, recordId, PDF_BYTES)).status).toBe(403);
      expect(
        (
          await h
            .http()
            .get(`/v1/consent/records/${recordId}/scan`)
            .set(bearer(w.empTokens.accessToken))
        ).status,
      ).toBe(403);
      expect(
        (
          await h
            .http()
            .get(`/v1/consent/records/${recordId}/scan`)
            .set(bearer(w.hrTokens.accessToken))
        ).body.code,
      ).toBe("SCAN_NOT_FOUND");
    });

    it("detects file types by magic bytes", () => {
      expect(detectScanType(PDF_BYTES)?.ext).toBe("pdf");
      expect(detectScanType(JPEG_BYTES)?.ext).toBe("jpg");
      expect(
        detectScanType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext,
      ).toBe("png");
      expect(detectScanType(Buffer.from("GIF89a"))).toBeNull();
    });
  });

  describe("tenant isolation", () => {
    it("one tenant cannot see, sign, print or withdraw another tenant's forms", async () => {
      const a = await setupWorld(h, { consent: false });
      const b = await setupWorld(h, { consent: false });
      await print(b.hrTokens.accessToken, [b.employee.id]);
      const [formB] = await records(b.employee.id);
      const recordB = (
        await h.owner.query("SELECT id FROM consent_record WHERE form_code = $1", [formB.form_code])
      ).rows[0].id as string;

      expect((await markSigned(a.hrTokens.accessToken, formB.form_code)).status).toBe(404);
      expect((await print(a.hrTokens.accessToken, [b.employee.id])).status).toBe(404);
      expect(
        (
          await h
            .http()
            .get(`/v1/employees/${b.employee.id}/consent`)
            .set(bearer(a.hrTokens.accessToken))
        ).status,
      ).toBe(404);
      expect(
        (
          await h
            .http()
            .put(`/v1/consent/records/${recordB}/scan`)
            .set(bearer(a.hrTokens.accessToken))
            .set("Content-Type", "application/pdf")
            .send(PDF_BYTES)
        ).status,
      ).toBe(404);
      expect(
        (
          await h
            .http()
            .post(`/v1/employees/${b.employee.id}/consent/withdraw`)
            .set(bearer(a.hrTokens.accessToken))
            .send({ withdrawnOn: today() })
        ).status,
      ).toBe(409);
      expect((await records(b.employee.id))[0].status).toBe("PRINTED");
      void createEmployeeWithUser;
    });
  });
});
