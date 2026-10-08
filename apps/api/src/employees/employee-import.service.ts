import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { ScopeService, type DataScope } from "../access/scope.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { DatabaseService } from "../database/database.service";
import { parseDate, YES } from "../tabular/parse";
import { readTable } from "../tabular/read";
import type { Table } from "../tabular/table";
import { EmployeesService, type EmployeeFields } from "./employees.service";

export type ImportMode = "VALID_ONLY" | "ABORT_ON_ERROR";
export type OnDuplicate = "SKIP" | "CREATE";
export type RowStatus = "OK" | "WARNING" | "ERROR";
export type RowAction = "CREATE" | "UPDATE" | null;

export interface ImportMessage {
  code: string;
  text: string;
}
export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}
export interface ImportRow {
  row: number;
  status: RowStatus;
  /** What committing does with the row; null for rows that are skipped or have errors. */
  action: RowAction;
  messages: ImportMessage[];
  fullName: string;
  /** The code in the file (updates) or, after a commit, the code the system gave to the new employee. */
  employeeNo: string | null;
  changes: FieldChange[];
}
export interface ImportReport {
  dryRun: boolean;
  committed: boolean;
  summary: {
    total: number;
    ok: number;
    warnings: number;
    errors: number;
    created: number;
    updated: number;
  };
  rows: ImportRow[];
  /** One-time logins of the employees created in this import (only when `createAccounts` was asked for). Never stored. */
  credentials?: Array<{
    employeeNo: string;
    fullName: string;
    username: string;
    temporaryPassword: string;
  }>;
}

/** Hashing a password takes about 50 ms, so logins for a very large file are created in a separate step. */
export const MAX_ACCOUNTS_PER_IMPORT = 400;

const ALIASES: Record<string, string[]> = {
  code: ["код", "ажилтны код", "employee code", "employee no", "code"],
  lastName: ["овог", "last name", "lastname", "family name"],
  firstName: ["нэр", "first name", "firstname", "given name"],
  department: ["нэгж", "хэлтэс", "department"],
  location: ["салбар", "үндсэн салбар", "location", "branch"],
  rank: ["цол", "rank"],
  position: ["албан тушаал", "position"],
  startDate: ["ажилд орсон", "ажилд орсон огноо", "эхлэх огноо", "start date", "start"],
  schedule: ["хуваарь", "ажлын хуваарь", "schedule"],
  manual: ["гараар ирц", "гараар", "manual attendance", "manual"],
};
const SCHEDULES: Record<string, "STANDARD" | "SHIFT"> = {
  энгийн: "STANDARD",
  standard: "STANDARD",
  ээлжийн: "SHIFT",
  shift: "SHIFT",
};
const NO_WORDS = new Set(["no", "n", "false", "0", "үгүй"]);

interface Existing {
  id: string;
  employeeNo: string;
  lastName: string;
  firstName: string;
  status: "ACTIVE" | "DISABLED" | "ARCHIVED";
  departmentId: string;
  departmentName: string;
  primaryLocationId: string;
  locationName: string;
  startDate: string | null;
  scheduleMode: "STANDARD" | "SHIFT";
  manualAttendance: boolean;
  rank: string | null;
  position: string | null;
}

interface Planned {
  row: ImportRow;
  create?: EmployeeFields;
  update?: { id: string; fields: Partial<EmployeeFields> };
}

const norm = (s: string) => s.trim().toLowerCase();
const same = (a: string | null, b: string | null) => norm(a ?? "") === norm(b ?? "");

/**
 * Bulk import of employees from .xlsx or CSV (PRD 12.3): a dry run that writes nothing and reports every row (valid / warning /
 * error, with a diff for updates), a choice between "valid rows only" and "abort on any error", text-only cells, at most 2,000 rows,
 * all rows committed in one transaction, audited. Rows without a code create employees (the system assigns the 16-digit code);
 * rows with the code of an existing employee update them (blank optional cells leave the value as it is). No password is imported:
 * with `createAccounts` each new employee gets a login with a random one-time password, returned once in the response.
 */
@Injectable()
export class EmployeeImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly passwords: PasswordService,
  ) {}

  /** Header row plus two example rows (Mongolian headers). */
  template(): Table {
    return {
      title: "Ажилтнуудын жагсаалт — импортын загвар",
      subtitle: [],
      columns: [
        { key: "code", header: "Код", width: 1.6 },
        { key: "lastName", header: "Овог", width: 1.2 },
        { key: "firstName", header: "Нэр", width: 1.2 },
        { key: "department", header: "Нэгж", width: 1.4 },
        { key: "location", header: "Салбар", width: 1.4 },
        { key: "rank", header: "Цол", width: 1.2 },
        { key: "position", header: "Албан тушаал", width: 1.6 },
        { key: "startDate", header: "Ажилд орсон", width: 1.2 },
        { key: "schedule", header: "Хуваарь", width: 1 },
        { key: "manual", header: "Гараар ирц", width: 1 },
      ],
      rows: [
        {
          code: "",
          lastName: "Бат",
          firstName: "Болд",
          department: "Агуулах",
          location: "Төв салбар",
          rank: "Ахмад",
          position: "Нярав",
          startDate: "2026-01-05",
          schedule: "Энгийн",
          manual: "үгүй",
        },
        {
          code: "",
          lastName: "Сараа",
          firstName: "Дорж",
          department: "Хамгаалалт",
          location: "ЭМАА",
          rank: "",
          position: "Жолооч",
          startDate: "",
          schedule: "Ээлжийн",
          manual: "тийм",
        },
      ],
    };
  }

  async run(
    auth: AuthContext,
    file: Buffer,
    opts: {
      dryRun: boolean;
      mode: ImportMode;
      onDuplicate: OnDuplicate;
      createAccounts: boolean;
      fileName?: string;
    },
    meta: RequestMeta,
  ): Promise<ImportReport> {
    const table = await readTable(file);
    const column = this.mapColumns(table.headers);

    return this.db.withTenant(auth.tenantId, async (tx) => {
      const scope = await this.scopes.forUser(tx, auth);
      const departments = new Map(
        (
          await tx.query<{ id: string; name: string; active: boolean }>(
            "SELECT id, name, active FROM department",
          )
        ).rows.map((d) => [norm(d.name), d]),
      );
      const locations = new Map(
        (
          await tx.query<{ id: string; name: string; active: boolean }>(
            "SELECT id, name, active FROM location",
          )
        ).rows.map((l) => [norm(l.name), l]),
      );
      const existingRows = (
        await tx.query<Existing>(
          `SELECT e.id, e.employee_no AS "employeeNo", e.last_name AS "lastName", e.first_name AS "firstName", e.status,
                  e.department_id AS "departmentId", d.name AS "departmentName",
                  e.primary_location_id AS "primaryLocationId", l.name AS "locationName",
                  e.start_date::text AS "startDate", e.schedule_mode AS "scheduleMode", e.manual_attendance AS "manualAttendance",
                  (SELECT a.title FROM employee_rank_assignment a WHERE a.employee_id = e.id AND a.valid_to IS NULL) AS rank,
                  (SELECT a.title FROM employee_position_assignment a WHERE a.employee_id = e.id AND a.valid_to IS NULL) AS position
             FROM employee e JOIN department d ON d.id = e.department_id JOIN location l ON l.id = e.primary_location_id`,
        )
      ).rows.filter((e) => this.inScope(scope, e.departmentId, e.primaryLocationId));
      const byCode = new Map(existingRows.map((e) => [e.employeeNo, e]));
      const people = new Set(
        existingRows
          .filter((e) => e.status !== "ARCHIVED")
          .map((e) => `${norm(e.lastName)}|${norm(e.firstName)}|${e.departmentId}`),
      );
      const codesInFile = new Set<string>();
      const peopleInFile = new Set<string>();

      const planned: Planned[] = table.rows.map(({ row, values }) => {
        const messages: ImportMessage[] = [];
        const err = (code: string, text: string) => messages.push({ code, text });
        const cell = (key: string) => (column[key] ? (values[column[key]!] ?? "") : "");
        const lastName = cell("lastName");
        const firstName = cell("firstName");
        const fullName = `${lastName} ${firstName}`.trim();
        const fail = (): Planned => ({
          row: {
            row,
            status: "ERROR",
            action: null,
            messages,
            fullName,
            employeeNo: cell("code") || null,
            changes: [],
          },
        });

        if (!lastName) err("LAST_NAME_REQUIRED", "Овог is required.");
        else if (lastName.length > 80)
          err("LAST_NAME_TOO_LONG", "Овог is longer than 80 characters.");
        if (!firstName) err("FIRST_NAME_REQUIRED", "Нэр is required.");
        else if (firstName.length > 80)
          err("FIRST_NAME_TOO_LONG", "Нэр is longer than 80 characters.");

        const department = departments.get(norm(cell("department")));
        if (!cell("department")) err("DEPARTMENT_REQUIRED", "Нэгж is required.");
        else if (!department)
          err("DEPARTMENT_UNKNOWN", `Department "${cell("department")}" does not exist.`);
        else if (!department.active)
          err("DEPARTMENT_INACTIVE", `Department "${department.name}" is inactive.`);
        const location = locations.get(norm(cell("location")));
        if (!cell("location")) err("LOCATION_REQUIRED", "Салбар is required.");
        else if (!location)
          err("LOCATION_UNKNOWN", `Location "${cell("location")}" does not exist.`);
        else if (!location.active)
          err("LOCATION_INACTIVE", `Location "${location.name}" is inactive.`);
        if (department && location && !this.inScope(scope, department.id, location.id)) {
          err("OUT_OF_SCOPE", "This department and location are outside your assigned scope.");
        }

        const rank = cell("rank");
        const position = cell("position");
        if (rank.length > 120) err("RANK_TOO_LONG", "Цол is longer than 120 characters.");
        if (position.length > 120)
          err("POSITION_TOO_LONG", "Албан тушаал is longer than 120 characters.");
        const startText = cell("startDate");
        const startDate = startText ? parseDate(startText) : null;
        if (startText && !startDate)
          err("START_DATE_INVALID", "Ажилд орсон must be a real date (YYYY-MM-DD).");
        const scheduleText = cell("schedule");
        const schedule = scheduleText ? SCHEDULES[norm(scheduleText)] : undefined;
        if (scheduleText && !schedule)
          err("SCHEDULE_INVALID", "Хуваарь must be Энгийн or Ээлжийн.");
        const manualText = norm(cell("manual"));
        const manual =
          manualText === ""
            ? undefined
            : YES.has(manualText)
              ? true
              : NO_WORDS.has(manualText)
                ? false
                : null;
        if (manual === null) err("MANUAL_INVALID", "Гараар ирц must be тийм or үгүй.");

        const code = cell("code");
        let current: Existing | undefined;
        if (code) {
          if (!/^\d{16}$/u.test(code)) err("CODE_INVALID", "Код must be 16 digits.");
          else if (codesInFile.has(code))
            err("CODE_DUPLICATE_IN_FILE", "This code appears twice in the file.");
          else {
            codesInFile.add(code);
            current = byCode.get(code);
            if (!current)
              err("CODE_NOT_FOUND", "No employee has this code (or it is outside your scope).");
            else if (current.status === "ARCHIVED")
              err("EMPLOYEE_ARCHIVED", "Archived employees are read-only.");
            else if (current.status === "DISABLED")
              err("EMPLOYEE_NOT_ACTIVE", "The employee is disabled; reactivate them first.");
          }
        }
        if (messages.length > 0 || !department || !location) return fail();

        if (current) {
          const changes: FieldChange[] = [];
          const fields: Partial<EmployeeFields> = {};
          const diff = (
            field: string,
            from: string | null,
            to: string | null,
            apply: () => void,
          ) => {
            changes.push({ field, from, to });
            apply();
          };
          if (!same(current.lastName, lastName))
            diff("lastName", current.lastName, lastName, () => (fields.lastName = lastName));
          if (!same(current.firstName, firstName))
            diff("firstName", current.firstName, firstName, () => (fields.firstName = firstName));
          if (current.departmentId !== department.id) {
            diff(
              "department",
              current.departmentName,
              department.name,
              () => (fields.departmentId = department.id),
            );
          }
          if (current.primaryLocationId !== location.id) {
            diff(
              "location",
              current.locationName,
              location.name,
              () => (fields.primaryLocationId = location.id),
            );
          }
          if (rank && !same(current.rank, rank))
            diff("rank", current.rank, rank, () => (fields.rank = rank));
          if (position && !same(current.position, position))
            diff("position", current.position, position, () => (fields.position = position));
          if (startDate && current.startDate !== startDate)
            diff("startDate", current.startDate, startDate, () => (fields.startDate = startDate));
          if (schedule && current.scheduleMode !== schedule)
            diff(
              "schedule",
              current.scheduleMode,
              schedule,
              () => (fields.scheduleMode = schedule),
            );
          if (manual !== undefined && manual !== null && current.manualAttendance !== manual) {
            diff(
              "manual",
              String(current.manualAttendance),
              String(manual),
              () => (fields.manualAttendance = manual),
            );
          }
          if (changes.length === 0) {
            messages.push({
              code: "NO_CHANGES",
              text: "Nothing differs from the register; skipped.",
            });
            return {
              row: {
                row,
                status: "WARNING",
                action: null,
                messages,
                fullName,
                employeeNo: code,
                changes,
              },
            };
          }
          return {
            row: {
              row,
              status: "OK",
              action: "UPDATE",
              messages,
              fullName,
              employeeNo: code,
              changes,
            },
            update: { id: current.id, fields },
          };
        }

        const key = `${norm(lastName)}|${norm(firstName)}|${department.id}`;
        if (opts.onDuplicate === "SKIP" && (people.has(key) || peopleInFile.has(key))) {
          messages.push({
            code: people.has(key) ? "ALREADY_EXISTS" : "DUPLICATE_IN_FILE",
            text: people.has(key)
              ? "An employee with this name exists in this department; skipped (put their code in the file to update, or import with duplicates allowed)."
              : "The same name and department appear earlier in the file; skipped.",
          });
          return {
            row: {
              row,
              status: "WARNING",
              action: null,
              messages,
              fullName,
              employeeNo: null,
              changes: [],
            },
          };
        }
        peopleInFile.add(key);
        return {
          row: {
            row,
            status: "OK",
            action: "CREATE",
            messages,
            fullName,
            employeeNo: null,
            changes: [],
          },
          create: {
            lastName,
            firstName,
            departmentId: department.id,
            primaryLocationId: location.id,
            ...(startDate ? { startDate } : {}),
            ...(schedule ? { scheduleMode: schedule } : {}),
            ...(manual !== undefined && manual !== null ? { manualAttendance: manual } : {}),
            ...(rank ? { rank } : {}),
            ...(position ? { position } : {}),
          },
        };
      });

      const rows = planned.map((p) => p.row);
      const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
      const creates = planned.filter((p) => p.create).length;
      const summary = {
        total: rows.length,
        ok: count("OK"),
        warnings: count("WARNING"),
        errors: count("ERROR"),
        created: 0,
        updated: 0,
      };
      const report: ImportReport = { dryRun: opts.dryRun, committed: false, summary, rows };
      if (opts.createAccounts && creates > MAX_ACCOUNTS_PER_IMPORT) {
        throw new ApiError(
          422,
          "TOO_MANY_ACCOUNTS",
          `Logins can be created for at most ${MAX_ACCOUNTS_PER_IMPORT} new employees per import; import without logins and create them afterwards.`,
          { newEmployees: creates },
        );
      }
      if (opts.dryRun) return report;
      if (opts.mode === "ABORT_ON_ERROR" && summary.errors > 0) {
        throw new ApiError(
          409,
          "IMPORT_HAS_ERRORS",
          "The file has errors and the import was set to abort; nothing was imported.",
          {
            report,
          },
        );
      }

      const credentials: NonNullable<ImportReport["credentials"]> = [];
      for (const p of planned) {
        if (p.create) {
          const created = (await this.employees.createIn(
            tx,
            auth,
            scope,
            p.create,
            meta,
          )) as unknown as { id: string; employeeNo: string };
          p.row.employeeNo = created.employeeNo;
          summary.created++;
          if (opts.createAccounts) {
            const temporaryPassword = this.passwords.generateTemporary();
            const passwordHash = await this.passwords.hash(temporaryPassword);
            const account = await this.employees.createAccountIn(
              tx,
              auth,
              scope,
              created.id,
              {},
              { temporaryPassword, passwordHash },
              meta,
            );
            credentials.push({
              employeeNo: created.employeeNo,
              fullName: p.row.fullName,
              username: account.username,
              temporaryPassword,
            });
          }
        } else if (p.update) {
          await this.employees.updateIn(tx, auth, scope, p.update.id, p.update.fields, meta);
          summary.updated++;
        }
      }
      report.committed = true;
      if (opts.createAccounts) report.credentials = credentials;
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "employee.imported",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "employee",
        // Counts only: no names and never a password.
        after: {
          fileName: opts.fileName ?? null,
          mode: opts.mode,
          onDuplicate: opts.onDuplicate,
          createAccounts: opts.createAccounts,
          ...summary,
        },
        ...meta,
      });
      return report;
    });
  }

  private inScope(scope: DataScope, departmentId: string, locationId: string): boolean {
    return (
      scope.unrestricted ||
      scope.locationIds.includes(locationId) ||
      scope.departmentIds.includes(departmentId)
    );
  }

  /** Maps the file's headers (Mongolian or English, any case) to the fields. */
  private mapColumns(headers: string[]): Record<string, string | undefined> {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const out: Record<string, string | undefined> = {};
    for (const [field, names] of Object.entries(ALIASES)) {
      const i = lower.findIndex((h) => names.includes(h));
      if (i >= 0) out[field] = headers[i];
    }
    const missing = ["lastName", "firstName", "department", "location"].filter((f) => !out[f]);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        "FILE_COLUMNS_MISSING",
        "Required columns are missing: Овог, Нэр, Нэгж, Салбар.",
        { missing },
      );
    }
    return out;
  }
}
