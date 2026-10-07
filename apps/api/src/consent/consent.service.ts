import { randomInt, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../common/config";
import { Clock } from "../common/clock";
import { ApiError } from "../common/api-error";
import { DatabaseService, type Db } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { ObjectStorage } from "../storage/object-storage";
import { parseConsentText } from "./consent-text";
import { type ConsentFormData, renderConsentForms } from "./pdf";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
const MAX_PRINT_BATCH = 500;

export const normalizeFormCode = (code: string): string => code.trim().toUpperCase();

function newFormCode(): string {
  const pick = () =>
    Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** The kind of file is decided from its content, never from what the client claims. */
export function detectScanType(data: Buffer): { ext: string; contentType: string } | null {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-")
    return { ext: "pdf", contentType: "application/pdf" };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return { ext: "jpg", contentType: "image/jpeg" };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png" };
  }
  return null;
}

type SkipReason = "ALREADY_SIGNED" | "EMPLOYEE_INACTIVE";

export interface PrintResult {
  pdf: Buffer;
  printed: { employeeId: string; formCode: string; reprint: boolean }[];
  skipped: { employeeId: string; reason: SkipReason }[];
}

@Injectable()
export class ConsentService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
  ) {}

  // ------------------------------------------------------------------ consent texts (Org Admin)

  async listTexts(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, version, language, is_draft AS "isDraft", active, created_at AS "createdAt",
                length(body) AS "length"
           FROM consent_text_version ORDER BY created_at DESC`,
      );
      return rows;
    });
  }

  async createText(
    auth: AuthContext,
    input: { version: string; body: string; isDraft: boolean },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      let id: string;
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO consent_text_version (tenant_id, version, body, is_draft)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [auth.tenantId, input.version, input.body, input.isDraft],
        );
        id = rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ApiError(409, "CONSENT_TEXT_VERSION_EXISTS", "That version already exists.");
        }
        throw error;
      }
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent_text.created",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_text_version",
        entityId: id,
        after: { version: input.version, isDraft: input.isDraft },
        ...meta,
      });
      return { id, version: input.version, isDraft: input.isDraft, active: false };
    });
  }

  /** Makes a version the one that is printed from now on. Existing signed forms stay valid. */
  async activateText(auth: AuthContext, id: string, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ version: string; is_draft: boolean }>(
        "SELECT version, is_draft FROM consent_text_version WHERE id = $1 FOR UPDATE",
        [id],
      );
      const text = found.rows[0];
      if (!text) throw new ApiError(404, "CONSENT_TEXT_NOT_FOUND", "Consent text not found.");
      await tx.query("UPDATE consent_text_version SET active = false WHERE active");
      await tx.query("UPDATE consent_text_version SET active = true WHERE id = $1", [id]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent_text.activated",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_text_version",
        entityId: id,
        after: { version: text.version, isDraft: text.is_draft },
        ...meta,
      });
      return { id, version: text.version, isDraft: text.is_draft, active: true };
    });
  }

  // ------------------------------------------------------------------ printing (HR)

  /**
   * Creates (or reuses) a PRINTED record for each employee and renders one page per form. Employees who
   * already have a signed form on the active text are skipped; employees signed on an older text get a new
   * form (re-consent). Printing the same unsigned form again reuses its form code.
   */
  async print(auth: AuthContext, employeeIds: string[], meta: RequestMeta): Promise<PrintResult> {
    if (employeeIds.length > MAX_PRINT_BATCH) {
      throw new ApiError(
        400,
        "TOO_MANY_EMPLOYEES",
        `At most ${MAX_PRINT_BATCH} forms per request.`,
      );
    }
    const unique = [...new Set(employeeIds)];

    const result = await this.db.withTenant(auth.tenantId, async (tx) => {
      const text = await tx.query<{ version: string; body: string; is_draft: boolean }>(
        "SELECT version, body, is_draft FROM consent_text_version WHERE active",
      );
      const active = text.rows[0];
      if (!active)
        throw new ApiError(
          409,
          "NO_ACTIVE_CONSENT_TEXT",
          "No consent text is active. Activate one first.",
        );
      if (active.is_draft && this.config.NODE_ENV === "production") {
        throw new ApiError(
          409,
          "CONSENT_TEXT_DRAFT",
          "The active consent text is a draft awaiting legal approval and cannot be printed.",
        );
      }
      const parsed = parseConsentText(active.body);

      const employees = await tx.query<{
        id: string;
        employee_no: string;
        full_name: string;
        status: string;
        department: string;
        location: string;
      }>(
        `SELECT e.id, e.employee_no, e.full_name, e.status, d.name AS department, l.name AS location
           FROM employee e
           JOIN department d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           JOIN location l ON l.tenant_id = e.tenant_id AND l.id = e.primary_location_id
          WHERE e.id = ANY($1::uuid[])`,
        [unique],
      );
      const byId = new Map(employees.rows.map((e) => [e.id, e]));
      const missing = unique.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Some employees were not found.", {
          employeeIds: missing,
        });
      }

      const signed = await tx.query<{ employee_id: string; text_version: string }>(
        "SELECT employee_id, text_version FROM consent_record WHERE status = 'SIGNED' AND employee_id = ANY($1::uuid[])",
        [unique],
      );
      const signedVersion = new Map(signed.rows.map((r) => [r.employee_id, r.text_version]));
      const pending = await tx.query<{ id: string; employee_id: string; form_code: string }>(
        `SELECT id, employee_id, form_code FROM consent_record
          WHERE status = 'PRINTED' AND text_version = $2 AND employee_id = ANY($1::uuid[])
          ORDER BY created_at DESC`,
        [unique, active.version],
      );
      const reusable = new Map<string, string>();
      for (const row of pending.rows)
        if (!reusable.has(row.employee_id)) reusable.set(row.employee_id, row.form_code);

      const printed: PrintResult["printed"] = [];
      const skipped: PrintResult["skipped"] = [];
      const forms: ConsentFormData[] = [];
      const printedOn = this.clock.now().toISOString().slice(0, 10);

      for (const employeeId of unique) {
        const employee = byId.get(employeeId)!;
        if (employee.status !== "ACTIVE") {
          skipped.push({ employeeId, reason: "EMPLOYEE_INACTIVE" });
          continue;
        }
        if (signedVersion.get(employeeId) === active.version) {
          skipped.push({ employeeId, reason: "ALREADY_SIGNED" });
          continue;
        }
        const existing = reusable.get(employeeId);
        const formCode =
          existing ?? (await this.insertPrintedRecord(tx, auth, employeeId, active.version));
        printed.push({ employeeId, formCode, reprint: existing !== undefined });
        forms.push({
          organization: await this.tenantName(tx, auth.tenantId),
          employeeName: employee.full_name,
          employeeNo: employee.employee_no,
          department: employee.department,
          location: employee.location,
          formCode,
          textVersion: active.version,
          isDraft: active.is_draft,
          printedOn,
          title: parsed.title,
          paragraphs: parsed.paragraphs,
        });
      }

      if (printed.length > 0) {
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          action: "consent.printed",
          actorUserId: auth.userId,
          actorRole: auth.role,
          entityType: "consent_record",
          after: {
            count: printed.length,
            version: active.version,
            employeeIds: printed.map((p) => p.employeeId),
          },
          ...meta,
        });
      }
      return { printed, skipped, forms };
    });

    if (result.printed.length === 0) {
      throw new ApiError(409, "NOTHING_TO_PRINT", "No forms to print.", {
        skipped: result.skipped,
      });
    }
    return {
      pdf: await renderConsentForms(result.forms),
      printed: result.printed,
      skipped: result.skipped,
    };
  }

  // ------------------------------------------------------------------ recording (HR)

  /** HR scanned or typed the form code from the signed paper (PRD 15.4: mark "Consent received"). */
  async markSigned(
    auth: AuthContext,
    input: { formCode: string; signedOn: string },
    meta: RequestMeta,
  ) {
    const now = this.clock.now();
    if (input.signedOn > new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10)) {
      throw new ApiError(400, "SIGNED_ON_IN_FUTURE", "The signing date cannot be in the future.");
    }
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{
        id: string;
        employee_id: string;
        status: string;
        printed_at: Date;
        text_version: string;
      }>(
        "SELECT id, employee_id, status, printed_at, text_version FROM consent_record WHERE form_code = $1 FOR UPDATE",
        [normalizeFormCode(input.formCode)],
      );
      const record = found.rows[0];
      if (!record) throw new ApiError(404, "FORM_NOT_FOUND", "No consent form with that code.");
      if (record.status !== "PRINTED") {
        throw new ApiError(409, "FORM_ALREADY_PROCESSED", `The form is already ${record.status}.`);
      }
      const printedDay = new Date(record.printed_at.getTime() - 24 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      if (input.signedOn < printedDay) {
        throw new ApiError(
          400,
          "SIGNED_BEFORE_PRINTED",
          "The signing date is before the form was printed.",
        );
      }

      // A newer signed form replaces the previous valid one (re-consent after a text change).
      const superseded = await tx.query(
        "UPDATE consent_record SET status = 'SUPERSEDED' WHERE employee_id = $1 AND status = 'SIGNED'",
        [record.employee_id],
      );
      await tx.query(
        `UPDATE consent_record
            SET status = 'SIGNED', signed_on = $2, received_at = $3, received_by = $4
          WHERE id = $1`,
        [record.id, input.signedOn, now, auth.userId],
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent.signed",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_record",
        entityId: record.id,
        after: {
          employeeId: record.employee_id,
          formCode: normalizeFormCode(input.formCode),
          signedOn: input.signedOn,
          textVersion: record.text_version,
          supersededPrevious: (superseded.rowCount ?? 0) > 0,
        },
        ...meta,
      });
      return {
        id: record.id,
        employeeId: record.employee_id,
        status: "SIGNED" as const,
        signedOn: input.signedOn,
      };
    });
  }

  /**
   * The employee withdraws consent in writing (PRD 15.4). The database disables their device and ends its
   * sessions. They are flagged "manual attendance" so HR can keep recording attendance another way.
   */
  async withdraw(
    auth: AuthContext,
    employeeId: string,
    input: { withdrawnOn: string; note?: string },
    meta: RequestMeta,
  ) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ id: string; signed_on: string }>(
        "SELECT id, signed_on::text FROM consent_record WHERE employee_id = $1 AND status = 'SIGNED' FOR UPDATE",
        [employeeId],
      );
      const record = found.rows[0];
      if (!record)
        throw new ApiError(
          409,
          "NO_SIGNED_CONSENT",
          "The employee has no signed consent to withdraw.",
        );
      if (input.withdrawnOn < record.signed_on) {
        throw new ApiError(
          400,
          "WITHDRAWN_BEFORE_SIGNED",
          "The withdrawal date is before the signing date.",
        );
      }
      const device = await tx.query(
        "SELECT 1 FROM device WHERE employee_id = $1 AND status = 'ACTIVE'",
        [employeeId],
      );

      await tx.query(
        `UPDATE consent_record
            SET status = 'WITHDRAWN', withdrawn_on = $2, withdrawn_by = $3, withdrawal_note = $4
          WHERE id = $1`,
        [record.id, input.withdrawnOn, auth.userId, input.note ?? null],
      );
      await tx.query("UPDATE employee SET manual_attendance = true WHERE id = $1", [employeeId]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent.withdrawn",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_record",
        entityId: record.id,
        after: {
          employeeId,
          withdrawnOn: input.withdrawnOn,
          deviceDisabled: (device.rowCount ?? 0) > 0,
        },
        ...meta,
      });
      return {
        id: record.id,
        status: "WITHDRAWN" as const,
        deviceDisabled: (device.rowCount ?? 0) > 0,
        manualAttendance: true,
      };
    });
  }

  // ------------------------------------------------------------------ reading

  async forEmployee(auth: AuthContext, employeeId: string) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const employee = await tx.query("SELECT 1 FROM employee WHERE id = $1", [employeeId]);
      if (employee.rowCount === 0)
        throw new ApiError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
      const status = await tx.query<{ status: string; signed_text_version: string | null }>(
        "SELECT status, signed_text_version FROM employee_consent_status WHERE employee_id = $1",
        [employeeId],
      );
      const activeVersion = await this.activeVersion(tx);
      const records = await tx.query(
        `SELECT id, form_code AS "formCode", text_version AS "textVersion", status,
                printed_at AS "printedAt", signed_on::text AS "signedOn", received_at AS "receivedAt",
                withdrawn_on::text AS "withdrawnOn", scan_object_key IS NOT NULL AS "hasScan"
           FROM consent_record WHERE employee_id = $1 ORDER BY created_at DESC`,
        [employeeId],
      );
      const current = status.rows[0];
      return {
        status: current?.status ?? "NOT_REQUESTED",
        signedTextVersion: current?.signed_text_version ?? null,
        activeTextVersion: activeVersion,
        reconsentRequired:
          current?.status === "SIGNED" &&
          activeVersion !== null &&
          current.signed_text_version !== activeVersion,
        records: records.rows,
      };
    });
  }

  /** Rollout tracking: counts per state and a page of employees (PRD 15.4). */
  async overview(auth: AuthContext, filter: { status?: string; limit: number; offset: number }) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const activeVersion = await this.activeVersion(tx);
      const counts = await tx.query<{ status: string; count: string }>(
        `SELECT s.status, count(*) AS count
           FROM employee_consent_status s JOIN employee e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
          WHERE e.status = 'ACTIVE' GROUP BY s.status`,
      );
      const summary: Record<string, number> = {
        NOT_REQUESTED: 0,
        PRINTED: 0,
        SIGNED: 0,
        WITHDRAWN: 0,
        RECONSENT_REQUIRED: 0,
      };
      for (const row of counts.rows) summary[row.status] = Number(row.count);
      if (activeVersion !== null) {
        const stale = await tx.query<{ count: string }>(
          `SELECT count(*) AS count
             FROM employee_consent_status s JOIN employee e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
            WHERE e.status = 'ACTIVE' AND s.status = 'SIGNED' AND s.signed_text_version <> $1`,
          [activeVersion],
        );
        summary.RECONSENT_REQUIRED = Number(stale.rows[0]?.count ?? 0);
      }
      const rows = await tx.query(
        `SELECT e.id AS "employeeId", e.employee_no AS "employeeNo", e.full_name AS "fullName",
                d.name AS department, l.name AS location, s.status, s.signed_text_version AS "signedTextVersion"
           FROM employee_consent_status s
           JOIN employee e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
           JOIN department d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           JOIN location l ON l.tenant_id = e.tenant_id AND l.id = e.primary_location_id
          WHERE e.status = 'ACTIVE' AND ($1::text IS NULL OR s.status = $1)
          ORDER BY e.employee_no LIMIT $2 OFFSET $3`,
        [filter.status ?? null, filter.limit, filter.offset],
      );
      return { activeTextVersion: activeVersion, summary, employees: rows.rows };
    });
  }

  // ------------------------------------------------------------------ scans of the signed paper

  async uploadScan(auth: AuthContext, recordId: string, data: Buffer, meta: RequestMeta) {
    const type = detectScanType(data);
    if (!type) throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", "Upload a PDF, JPEG or PNG file.");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ status: string }>(
        "SELECT status FROM consent_record WHERE id = $1 FOR UPDATE",
        [recordId],
      );
      if (!found.rows[0]) throw new ApiError(404, "FORM_NOT_FOUND", "Consent form not found.");
      if (found.rows[0].status === "PRINTED") {
        throw new ApiError(
          409,
          "FORM_NOT_SIGNED",
          "Mark the form as signed before attaching a scan.",
        );
      }
      const key = `${auth.tenantId}/consent/${recordId}-${randomUUID()}.${type.ext}`;
      await this.storage.put(key, data);
      await tx.query("UPDATE consent_record SET scan_object_key = $2 WHERE id = $1", [
        recordId,
        key,
      ]);
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent.scan_uploaded",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_record",
        entityId: recordId,
        after: { bytes: data.length, contentType: type.contentType },
        ...meta,
      });
      return { id: recordId, bytes: data.length, contentType: type.contentType };
    });
  }

  async downloadScan(auth: AuthContext, recordId: string, meta: RequestMeta) {
    return this.db.withTenant(auth.tenantId, async (tx) => {
      const found = await tx.query<{ scan_object_key: string | null }>(
        "SELECT scan_object_key FROM consent_record WHERE id = $1",
        [recordId],
      );
      const key = found.rows[0]?.scan_object_key;
      if (!key) throw new ApiError(404, "SCAN_NOT_FOUND", "No scan attached to this form.");
      const data = await this.storage.get(key);
      if (!data) throw new ApiError(404, "SCAN_NOT_FOUND", "The stored file is missing.");
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "consent.scan_viewed",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "consent_record",
        entityId: recordId,
        ...meta,
      });
      return { data, contentType: detectScanType(data)?.contentType ?? "application/octet-stream" };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async insertPrintedRecord(
    tx: Db,
    auth: AuthContext,
    employeeId: string,
    version: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const formCode = newFormCode();
      const { rowCount } = await tx.query(
        `INSERT INTO consent_record (tenant_id, employee_id, form_code, text_version, printed_at, printed_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, form_code) DO NOTHING`,
        [auth.tenantId, employeeId, formCode, version, this.clock.now(), auth.userId],
      );
      if (rowCount === 1) return formCode;
    }
    throw new Error("Could not allocate a unique consent form code");
  }

  private async activeVersion(tx: Db): Promise<string | null> {
    const { rows } = await tx.query<{ version: string }>(
      "SELECT version FROM consent_text_version WHERE active",
    );
    return rows[0]?.version ?? null;
  }

  private tenantNameCache = new Map<string, string>();
  private async tenantName(tx: Db, tenantId: string): Promise<string> {
    const cached = this.tenantNameCache.get(tenantId);
    if (cached) return cached;
    const { rows } = await tx.query<{ name: string }>("SELECT name FROM tenant WHERE id = $1", [
      tenantId,
    ]);
    const name = rows[0]?.name ?? "";
    this.tenantNameCache.set(tenantId, name);
    return name;
  }
}
