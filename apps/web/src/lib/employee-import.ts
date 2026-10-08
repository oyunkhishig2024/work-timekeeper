import { uploadFile } from "./api";

export type RowStatus = "OK" | "WARNING" | "ERROR";
export type Mode = "VALID_ONLY" | "ABORT_ON_ERROR";
export type OnDuplicate = "SKIP" | "CREATE";

export interface ImportRow {
  row: number;
  status: RowStatus;
  action: "CREATE" | "UPDATE" | null;
  messages: Array<{ code: string; text: string }>;
  fullName: string;
  employeeNo: string | null;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
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
  credentials?: Array<{
    employeeNo: string;
    fullName: string;
    username: string;
    temporaryPassword: string;
  }>;
}

export interface ImportOptions {
  dryRun: boolean;
  mode: Mode;
  onDuplicate: OnDuplicate;
  createAccounts: boolean;
  fileName: string;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ACCOUNTS = 400;

/** What HR reads for each problem the API can report; unknown codes show the API's own text. */
const MESSAGE: Record<string, string> = {
  LAST_NAME_REQUIRED: "Овог хоосон байна.",
  FIRST_NAME_REQUIRED: "Нэр хоосон байна.",
  LAST_NAME_TOO_LONG: "Овог 80 тэмдэгтээс урт байна.",
  FIRST_NAME_TOO_LONG: "Нэр 80 тэмдэгтээс урт байна.",
  DEPARTMENT_REQUIRED: "Нэгж хоосон байна.",
  DEPARTMENT_UNKNOWN: "Ийм нэртэй нэгж байхгүй.",
  DEPARTMENT_INACTIVE: "Нэгж идэвхгүй байна.",
  LOCATION_REQUIRED: "Салбар хоосон байна.",
  LOCATION_UNKNOWN: "Ийм нэртэй салбар байхгүй.",
  LOCATION_INACTIVE: "Салбар идэвхгүй байна.",
  OUT_OF_SCOPE: "Энэ нэгж, салбар таны хамрах хүрээнд ороогүй.",
  RANK_TOO_LONG: "Цол 120 тэмдэгтээс урт байна.",
  POSITION_TOO_LONG: "Албан тушаал 120 тэмдэгтээс урт байна.",
  START_DATE_INVALID: "Ажилд орсон огноо буруу (YYYY-MM-DD).",
  SCHEDULE_INVALID: "Хуваарь нь «Энгийн» эсвэл «Ээлжийн» байх ёстой.",
  MANUAL_INVALID: "Гараар ирц нь «тийм» эсвэл «үгүй» байх ёстой.",
  CODE_INVALID: "Код 16 оронтой тоо байх ёстой.",
  CODE_NOT_FOUND: "Энэ кодтой ажилтан олдсонгүй (эсвэл таны хамрах хүрээнээс гадуур).",
  CODE_DUPLICATE_IN_FILE: "Энэ код файлд хоёр удаа орсон.",
  EMPLOYEE_ARCHIVED: "Архивласан ажилтныг өөрчилж болохгүй.",
  EMPLOYEE_NOT_ACTIVE: "Ажилтан идэвхгүй байна. Эхлээд дахин идэвхжүүлнэ үү.",
  NO_CHANGES: "Бүртгэлээс ялгаагүй тул алгаслаа.",
  ALREADY_EXISTS: "Энэ нэгжид ижил нэртэй ажилтан байна, алгаслаа. Шинэчлэх бол кодыг нь бичнэ үү.",
  DUPLICATE_IN_FILE: "Файлд өмнө нь ижил нэр, нэгжтэй мөр байна, алгаслаа.",
};
export const messageText = (m: { code: string; text: string }): string => MESSAGE[m.code] ?? m.text;

const FIELD: Record<string, string> = {
  lastName: "Овог",
  firstName: "Нэр",
  department: "Нэгж",
  location: "Салбар",
  rank: "Цол",
  position: "Албан тушаал",
  startDate: "Ажилд орсон",
  schedule: "Хуваарь",
  manual: "Гараар ирц",
};
export const fieldLabel = (field: string): string => FIELD[field] ?? field;

export function importUrl(o: ImportOptions): string {
  const q = new URLSearchParams({
    dryRun: String(o.dryRun),
    mode: o.mode,
    onDuplicate: o.onDuplicate,
    createAccounts: String(o.createAccounts),
    fileName: o.fileName.slice(0, 200),
  });
  return `/v1/employees/import?${q}`;
}

export const runImport = (file: File, o: ImportOptions) =>
  uploadFile<ImportReport>(importUrl(o), file);

/** Client-side check before the file is sent. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(xlsx|csv)$/iu.test(file.name)) return "Зөвхөн .xlsx эсвэл .csv файл оруулна.";
  if (file.size === 0) return "Файл хоосон байна.";
  if (file.size > MAX_FILE_BYTES) return "Файл 5 МБ-аас том байна.";
  return null;
}

/** A cell that starts with = + - @ would be run as a formula by a spreadsheet; a leading ' keeps it text. */
export function csvCell(value: string | number | null | undefined): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  // The byte-order mark makes Excel open Cyrillic correctly.
  return (
    String.fromCharCode(0xfeff) +
    [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")
  );
}

/** The imported rows with the codes the system gave them: upload it again later to update the same people. */
export function resultSheet(report: ImportReport): string {
  return toCsv(
    ["Мөр", "Код", "Овог нэр", "Үр дүн", "Тайлбар"],
    report.rows.map((r) => [
      r.row,
      r.employeeNo ?? "",
      r.fullName,
      r.action === "CREATE"
        ? "Нэмсэн"
        : r.action === "UPDATE"
          ? "Шинэчилсэн"
          : r.status === "ERROR"
            ? "Алдаа"
            : "Алгассан",
      r.messages.map(messageText).join(" "),
    ]),
  );
}

/** One-time logins, for handing to the employees. Shown once; the server keeps no copy. */
export function credentialsSheet(report: ImportReport): string {
  return toCsv(
    ["Код", "Овог нэр", "Нэвтрэх нэр", "Нэг удаагийн нууц үг"],
    (report.credentials ?? []).map((c) => [
      c.employeeNo,
      c.fullName,
      c.username,
      c.temporaryPassword,
    ]),
  );
}
