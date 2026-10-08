import { resolve } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { Cell, Table } from "./table";

const FONT_REGULAR = resolve(__dirname, "../../assets/fonts/DejaVuSans.ttf");
const FONT_BOLD = resolve(__dirname, "../../assets/fonts/DejaVuSans-Bold.ttf");

/** Cells that a spreadsheet would run as a formula (CSV/formula injection). Text is shown as written. */
const DANGEROUS_START = /^[=+\-@\t\r]/u;
export const neutralize = (value: string): string =>
  DANGEROUS_START.test(value) ? `'${value}` : value;

export async function toXlsx(
  table: Table,
  generatedBy: string,
  generatedAt: Date,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = generatedBy;
  workbook.created = generatedAt;
  const sheet = workbook.addWorksheet(table.title.slice(0, 31).replace(/[\\/?*[\]:]/gu, " "));
  sheet.columns = table.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(10, Math.round((c.width ?? 1) * 14)),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of table.rows) {
    // Strings are stored as text cells, so "=1+1" shows as text and is never evaluated.
    sheet.addRow(table.columns.map((c) => row[c.key] ?? null));
  }
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, table.columns.length) },
  };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const csvCell = (value: Cell): string => {
  if (value === null) return "";
  const text = typeof value === "string" ? neutralize(value) : String(value);
  return /[",\r\n;]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
};

const BOM = String.fromCharCode(0xfeff);

/** UTF-8 with a byte-order mark so Excel opens Cyrillic correctly; comma separated, CRLF lines. */
export function toCsv(table: Table): Buffer {
  const lines = [table.columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of table.rows)
    lines.push(table.columns.map((c) => csvCell(row[c.key] ?? null)).join(","));
  return Buffer.from(`${BOM}${lines.join("\r\n")}\r\n`, "utf8");
}

/** Print-ready landscape A4: title, organization / period / filters, who and when, repeated table header. */
export async function toPdf(table: Table, generatedBy: string, generatedAt: Date): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 40, left: 36, right: 36, bottom: 36 },
    info: { Title: table.title, Producer: "Timekeeper Work", Author: generatedBy },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((done, fail) => {
    doc.on("end", () => done(Buffer.concat(chunks)));
    doc.on("error", fail);
  });
  doc.registerFont("regular", FONT_REGULAR);
  doc.registerFont("bold", FONT_BOLD);

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 14;
  const totalWeight = table.columns.reduce((n, c) => n + (c.width ?? 1), 0) || 1;
  const widths = table.columns.map((c) => ((c.width ?? 1) / totalWeight) * width);
  const fontSize = table.columns.length > 14 ? 6.5 : table.columns.length > 9 ? 7.5 : 9;
  const rowHeight = fontSize + 7;

  const drawRow = (cells: string[], y: number, bold: boolean) => {
    doc.font(bold ? "bold" : "regular").fontSize(fontSize);
    if (bold)
      doc
        .rect(left, y - 2, width, rowHeight)
        .fill("#e6efec")
        .fillColor("black");
    let x = left;
    cells.forEach((text, i) => {
      doc.text(text, x + 3, y + 1, {
        width: widths[i]! - 6,
        height: rowHeight - 3,
        lineBreak: false,
        ellipsis: true,
      });
      x += widths[i]!;
    });
    doc
      .moveTo(left, y + rowHeight - 2)
      .lineTo(left + width, y + rowHeight - 2)
      .strokeColor("#d0d8d5")
      .lineWidth(0.4)
      .stroke();
  };

  doc.font("bold").fontSize(15).text(table.title, left, doc.page.margins.top);
  doc.font("regular").fontSize(9).fillColor("#444444");
  for (const line of table.subtitle) doc.text(line);
  doc.text(
    `Гаргасан: ${generatedBy} · ${generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC · ${table.rows.length} мөр`,
  );
  doc.fillColor("black").moveDown(0.6);

  const headers = table.columns.map((c) => c.header);
  let y = doc.y;
  drawRow(headers, y, true);
  y += rowHeight;
  for (const row of table.rows) {
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawRow(headers, y, true);
      y += rowHeight;
    }
    drawRow(
      table.columns.map((c) =>
        row[c.key] === null || row[c.key] === undefined ? "" : String(row[c.key]),
      ),
      y,
      false,
    );
    y += rowHeight;
  }
  if (table.rows.length === 0)
    doc
      .font("regular")
      .fontSize(10)
      .text("Өгөгдөл олдсонгүй.", left, y + 6);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font("regular").fontSize(8).fillColor("#666666");
    doc.text(
      `Хуудас ${i + 1} / ${range.count}`,
      left,
      doc.page.height - doc.page.margins.bottom + 6,
      {
        width,
        align: "right",
        lineBreak: false,
      },
    );
  }
  doc.end();
  return finished;
}
