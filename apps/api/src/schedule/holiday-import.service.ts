import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/api-error";
import { Clock } from "../common/clock";
import { tenantToday } from "../common/tenant-today";
import { DatabaseService } from "../database/database.service";
import { AuditService } from "../audit/audit.service";
import type { AuthContext, RequestMeta } from "../auth/auth.types";
import { NO, parseDate, YES } from "../tabular/parse";
import { readTable } from "../tabular/read";
import type { Table } from "../tabular/table";
import { HolidaysService, type HolidayInput, type HolidayKind } from "./holidays.service";

export type ImportMode = "VALID_ONLY" | "ABORT_ON_ERROR";
export type RowStatus = "OK" | "WARNING" | "ERROR";

export interface ImportMessage {
  code: string;
  text: string;
}
export interface ImportRow {
  row: number;
  status: RowStatus;
  messages: ImportMessage[];
  data: HolidayInput | null;
}
export interface ImportReport {
  dryRun: boolean;
  committed: boolean;
  summary: { total: number; ok: number; warnings: number; errors: number; created: number };
  rows: ImportRow[];
}

const ALIASES: Record<string, string[]> = {
  name: ["name", "нэр", "баярын нэр"],
  from: ["from", "from date", "эхлэх", "эхлэх огноо"],
  to: ["to", "to date", "дуусах", "дуусах огноо"],
  type: ["type", "kind", "төрөл"],
  locations: ["locations", "location", "салбар", "салбарууд"],
  repeats: ["repeats yearly", "repeats", "жил бүр", "жил бүр давтагдах"],
};

const KINDS: Record<string, HolidayKind> = {
  public_holiday: "PUBLIC_HOLIDAY",
  "public holiday": "PUBLIC_HOLIDAY",
  "нийтийн баяр": "PUBLIC_HOLIDAY",
  "төрийн баяр": "PUBLIC_HOLIDAY",
  company_day_off: "COMPANY_DAY_OFF",
  "company day off": "COMPANY_DAY_OFF",
  "компанийн амралт": "COMPANY_DAY_OFF",
  transferred_day_off: "TRANSFERRED_DAY_OFF",
  "transferred day off": "TRANSFERRED_DAY_OFF",
  "шилжүүлсэн амралт": "TRANSFERRED_DAY_OFF",
};
const ALL_WORDS = new Set(["", "all", "бүгд", "бүх салбар", "*"]);

const dayMs = 86_400_000;

/**
 * Bulk import of holidays from .xlsx or CSV (PRD 14.2) with the import safety rules of PRD 12.3: a dry run that
 * writes nothing and returns a per-row report, a choice between "valid rows only" and "abort on any error",
 * text-only cells, at most 2,000 rows, audited. Idempotent: a holiday whose name and start date already exist is
 * skipped with a warning. Dates that are today or earlier need `confirmRecompute` like manual changes do.
 */
@Injectable()
export class HolidayImportService {
  constructor(
    private readonly clock: Clock,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly holidays: HolidaysService,
  ) {}

  /** Header row plus two example rows (Mongolian headers). */
  template(): Table {
    return {
      title: "Баярын жагсаалт — импортын загвар",
      subtitle: [],
      columns: [
        { key: "name", header: "Нэр", width: 2 },
        { key: "from", header: "Эхлэх", width: 1 },
        { key: "to", header: "Дуусах", width: 1 },
        { key: "type", header: "Төрөл", width: 1.4 },
        { key: "locations", header: "Салбар", width: 1.6 },
        { key: "repeats", header: "Жил бүр", width: 1 },
      ],
      rows: [
        {
          name: "Шинэ жил",
          from: "2027-01-01",
          to: "2027-01-01",
          type: "PUBLIC_HOLIDAY",
          locations: "all",
          repeats: "yes",
        },
        {
          name: "Компанийн ой",
          from: "2027-05-20",
          to: "2027-05-21",
          type: "COMPANY_DAY_OFF",
          locations: "Төв салбар, ЭМАА",
          repeats: "no",
        },
      ],
    };
  }

  async run(
    auth: AuthContext,
    file: Buffer,
    opts: { dryRun: boolean; mode: ImportMode; confirmRecompute: boolean; fileName?: string },
    meta: RequestMeta,
  ): Promise<ImportReport> {
    const table = await readTable(file);
    const column = this.mapColumns(table.headers);

    return this.db.withTenant(auth.tenantId, async (tx) => {
      const today = await tenantToday(tx, this.clock, auth.tenantId);
      const locationRows = await tx.query<{ id: string; name: string }>(
        "SELECT id, name FROM location",
      );
      const locationByName = new Map(
        locationRows.rows.map((l) => [l.name.trim().toLowerCase(), l.id]),
      );
      const existing = await tx.query<{ name: string; from: string }>(
        `SELECT name, from_date::text AS "from" FROM holiday`,
      );
      const known = new Set(existing.rows.map((h) => `${h.name.trim().toLowerCase()}|${h.from}`));
      const seen = new Set<string>();

      const rows: ImportRow[] = table.rows.map(({ row, values }) => {
        const messages: ImportMessage[] = [];
        const err = (code: string, text: string) => messages.push({ code, text });
        const cell = (key: string) => (column[key] ? (values[column[key]!] ?? "") : "");

        const name = cell("name");
        if (!name) err("NAME_REQUIRED", "Name is required.");
        else if (name.length > 160) err("NAME_TOO_LONG", "Name is longer than 160 characters.");

        const from = parseDate(cell("from"));
        const toText = cell("to");
        const to = toText === "" ? from : parseDate(toText);
        if (!from) err("FROM_INVALID", "Start date must be a real date (YYYY-MM-DD).");
        if (toText !== "" && !to) err("TO_INVALID", "End date must be a real date (YYYY-MM-DD).");
        if (from && to) {
          const days = (Date.parse(to) - Date.parse(from)) / dayMs;
          if (days < 0) err("DATES_REVERSED", "End date is before the start date.");
          else if (days > 30) err("RANGE_TOO_LONG", "A holiday spans at most 31 days.");
        }

        const kindText = cell("type").trim().toLowerCase();
        const kind = kindText === "" ? "PUBLIC_HOLIDAY" : KINDS[kindText];
        if (!kind) err("TYPE_INVALID", `Unknown type "${cell("type")}".`);

        const locText = cell("locations").trim().toLowerCase();
        let appliesToAll = true;
        const locationIds: string[] = [];
        if (!ALL_WORDS.has(locText)) {
          appliesToAll = false;
          for (const part of cell("locations")
            .split(/[,;]/u)
            .map((p) => p.trim())
            .filter(Boolean)) {
            const found = locationByName.get(part.toLowerCase());
            if (found) locationIds.push(found);
            else err("LOCATION_NOT_FOUND", `Location "${part}" does not exist.`);
          }
          if (locationIds.length === 0 && !messages.some((m) => m.code === "LOCATION_NOT_FOUND")) {
            err("LOCATION_NOT_FOUND", "No location given.");
          }
        }

        const repeatsText = cell("repeats").trim().toLowerCase();
        if (!YES.has(repeatsText) && !NO.has(repeatsText))
          err("REPEATS_INVALID", `"${cell("repeats")}" is not yes/no.`);

        if (from && name) {
          const key = `${name.trim().toLowerCase()}|${from}`;
          if (seen.has(key))
            err("DUPLICATE_IN_FILE", "The same name and start date appear earlier in the file.");
          seen.add(key);
        }
        if (from && from <= today && !opts.confirmRecompute) {
          err(
            "RECOMPUTE_CONFIRMATION_REQUIRED",
            "Starts today or in the past; confirm the recompute to import it.",
          );
        }

        if (messages.length > 0 || !from || !to || !kind) {
          return { row, status: "ERROR", messages, data: null };
        }
        const data: HolidayInput = {
          name,
          fromDate: from,
          toDate: to,
          kind,
          repeatsYearly: YES.has(repeatsText),
          appliesToAll,
          locationIds: [...new Set(locationIds)],
        };
        if (known.has(`${name.trim().toLowerCase()}|${from}`)) {
          return {
            row,
            status: "WARNING",
            messages: [
              {
                code: "ALREADY_EXISTS",
                text: "A holiday with this name and start date exists; skipped.",
              },
            ],
            data,
          };
        }
        return { row, status: "OK", messages, data };
      });

      const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
      const summary = {
        total: rows.length,
        ok: count("OK"),
        warnings: count("WARNING"),
        errors: count("ERROR"),
        created: 0,
      };
      const report: ImportReport = { dryRun: opts.dryRun, committed: false, summary, rows };
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
      for (const r of rows) {
        if (r.status === "OK" && r.data) await this.holidays.insertHoliday(tx, auth, r.data);
      }
      summary.created = summary.ok;
      report.committed = true;
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        action: "holiday.imported",
        actorUserId: auth.userId,
        actorRole: auth.role,
        entityType: "holiday",
        after: { fileName: opts.fileName ?? null, mode: opts.mode, ...summary },
        ...meta,
      });
      return report;
    });
  }

  /** Maps the file's headers (Mongolian or English, any case) to the fields; name and start date are required. */
  private mapColumns(headers: string[]): Record<string, string | undefined> {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const out: Record<string, string | undefined> = {};
    for (const [field, names] of Object.entries(ALIASES)) {
      const i = lower.findIndex((h) => names.includes(h));
      if (i >= 0) out[field] = headers[i];
    }
    const missing = ["name", "from"].filter((f) => !out[f]);
    if (missing.length > 0) {
      throw new ApiError(
        400,
        "FILE_COLUMNS_MISSING",
        "Required columns are missing: name (Нэр), from (Эхлэх).",
        { missing },
      );
    }
    return out;
  }
}
