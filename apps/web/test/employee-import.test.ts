import { describe, expect, it } from "vitest";
import {
  credentialsSheet,
  csvCell,
  fieldLabel,
  fileProblem,
  importUrl,
  messageText,
  resultSheet,
  toCsv,
  type ImportReport,
} from "../src/lib/employee-import";

const BOM = String.fromCharCode(0xfeff);

describe("file check", () => {
  it("accepts .xlsx and .csv up to 5 MB", () => {
    expect(fileProblem({ name: "Ажилтнууд.XLSX", size: 1000 })).toBeNull();
    expect(fileProblem({ name: "a.csv", size: 1000 })).toBeNull();
    expect(fileProblem({ name: "a.xls", size: 1000 })).toMatch(/xlsx/u);
    expect(fileProblem({ name: "a.csv", size: 0 })).toMatch(/хоосон/u);
    expect(fileProblem({ name: "a.csv", size: 5 * 1024 * 1024 + 1 })).toMatch(/5 МБ/u);
  });
});

describe("request URL", () => {
  it("carries every option and a bounded file name", () => {
    const url = importUrl({
      dryRun: true,
      mode: "ABORT_ON_ERROR",
      onDuplicate: "CREATE",
      createAccounts: true,
      fileName: "а&б.csv",
    });
    expect(url).toBe(
      "/v1/employees/import?dryRun=true&mode=ABORT_ON_ERROR&onDuplicate=CREATE&createAccounts=true&fileName=%D0%B0%26%D0%B1.csv",
    );
    expect(
      importUrl({
        dryRun: false,
        mode: "VALID_ONLY",
        onDuplicate: "SKIP",
        createAccounts: false,
        fileName: "x".repeat(500),
      }).length,
    ).toBeLessThan(300);
  });
});

describe("messages", () => {
  it("translates what the API reports and falls back to its own text", () => {
    expect(
      messageText({ code: "DEPARTMENT_UNKNOWN", text: "Department X does not exist." }),
    ).toMatch(/нэгж/u);
    expect(messageText({ code: "SOMETHING_NEW", text: "New problem." })).toBe("New problem.");
    expect(fieldLabel("department")).toBe("Нэгж");
    expect(fieldLabel("other")).toBe("other");
  });
});

describe("CSV sheets", () => {
  it("quotes commas, quotes and line breaks, and keeps spreadsheet formulas from running", () => {
    expect(csvCell("Бат, Болд")).toBe('"Бат, Болд"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+7")).toBe("'+7");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
  it("starts with a byte-order mark so Excel reads Cyrillic", () => {
    expect(toCsv(["А"], [["б"]])).toBe(`${BOM}А\r\nб`);
  });
  const report: ImportReport = {
    dryRun: false,
    committed: true,
    summary: { total: 3, ok: 2, warnings: 0, errors: 1, created: 1, updated: 1 },
    rows: [
      {
        row: 2,
        status: "OK",
        action: "CREATE",
        messages: [],
        fullName: "Бат Болд",
        employeeNo: "2026100800000001",
        changes: [],
      },
      {
        row: 3,
        status: "OK",
        action: "UPDATE",
        messages: [],
        fullName: "Сараа Дорж",
        employeeNo: "2026100800000002",
        changes: [],
      },
      {
        row: 4,
        status: "ERROR",
        action: null,
        messages: [{ code: "LOCATION_UNKNOWN", text: "x" }],
        fullName: "Оюун Цэцэг",
        employeeNo: null,
        changes: [],
      },
    ],
    credentials: [
      {
        employeeNo: "2026100800000001",
        fullName: "Бат Болд",
        username: "2026100800000001",
        temporaryPassword: "Ab-1x",
      },
    ],
  };
  it("the result sheet lists the codes for a later update", () => {
    const lines = resultSheet(report).slice(1).split("\r\n");
    expect(lines[0]).toBe("Мөр,Код,Овог нэр,Үр дүн,Тайлбар");
    expect(lines[1]).toBe("2,2026100800000001,Бат Болд,Нэмсэн,");
    expect(lines[2]).toContain("Шинэчилсэн");
    expect(lines[3]).toContain("Алдаа");
    expect(lines[3]).toContain("салбар");
  });
  it("the logins sheet carries the one-time passwords", () => {
    expect(credentialsSheet(report).slice(1).split("\r\n")).toEqual([
      "Код,Овог нэр,Нэвтрэх нэр,Нэг удаагийн нууц үг",
      "2026100800000001,Бат Болд,2026100800000001,Ab-1x",
    ]);
    expect(
      credentialsSheet({ ...report, credentials: undefined })
        .slice(1)
        .split("\r\n"),
    ).toHaveLength(1);
  });
});
