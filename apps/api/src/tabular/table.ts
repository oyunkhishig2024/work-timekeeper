export type Cell = string | number | boolean | null;

export interface Column {
  key: string;
  header: string;
  /** Relative width (default 1) used by the PDF layout and as the Excel column width hint. */
  width?: number;
}

/** A flat table: what every export produces, whatever the format (PRD 20: flat/tabular to allow pivoting). */
export interface Table {
  title: string;
  /** Lines under the title in the PDF (organization, period, filters). */
  subtitle: string[];
  columns: Column[];
  rows: Array<Record<string, Cell>>;
}

export type ExportFormat = "xlsx" | "csv" | "pdf";

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};
