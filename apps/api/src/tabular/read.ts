import ExcelJS from "exceljs";
import { ApiError } from "../common/api-error";

export const MAX_IMPORT_ROWS = 2000;

export interface ReadRow {
  /** Row number in the file (the header is row 1). */
  row: number;
  values: Record<string, string>;
}

export interface ReadTable {
  headers: string[];
  rows: ReadRow[];
}

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;

/**
 * Reads the first sheet of an .xlsx file or a CSV file into text cells. Everything is text: a cell that starts with
 * `=`, `+`, `-` or `@` is just text here (never evaluated), formulas are read as their stored result (PRD 12.3).
 * The type is decided from the content, not from the name. At most 2,000 data rows.
 */
export async function readTable(buffer: Buffer): Promise<ReadTable> {
  const grid = isZip(buffer) ? await readXlsx(buffer) : readCsv(buffer);
  const [head, ...body] = grid;
  if (!head || head.every((h) => h === "")) {
    throw new ApiError(400, "FILE_EMPTY", "The file has no header row.");
  }
  const headers = head.map((h) => h.trim());
  const rows: ReadRow[] = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return; // blank line
    const values: Record<string, string> = {};
    headers.forEach((h, c) => {
      if (h) values[h] = (cells[c] ?? "").trim();
    });
    rows.push({ row: i + 2, values });
  });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(413, "TOO_MANY_ROWS", `At most ${MAX_IMPORT_ROWS} rows per file.`, {
      rows: rows.length,
    });
  }
  return { headers, rows };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined)
      return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text);
    if ("error" in value) return "";
  }
  return String(value);
}

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ApiError(400, "FILE_UNREADABLE", "The file is not a valid .xlsx workbook.");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ApiError(400, "FILE_EMPTY", "The workbook has no sheet.");
  const grid: string[][] = [];
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: true }, (row, index) => {
    if (index > MAX_IMPORT_ROWS + 50) return;
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
    grid[index - 1] = cells;
  });
  return Array.from(grid, (r) => r ?? []);
}

/** RFC 4180 with quoted fields and doubled quotes; `,` or `;` as the separator (decided from the header line). */
function readCsv(buffer: Buffer): string[][] {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000"))
    throw new ApiError(400, "FILE_UNREADABLE", "The file is not text or .xlsx.");
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const sep =
    (firstLine.match(/;/gu)?.length ?? 0) > (firstLine.match(/,/gu)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
