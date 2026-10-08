"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ApiRequestError, download } from "@/lib/api";
import {
  credentialsSheet,
  fieldLabel,
  fileProblem,
  MAX_ACCOUNTS,
  messageText,
  resultSheet,
  runImport,
  type ImportOptions,
  type ImportReport,
  type ImportRow,
  type Mode,
  type OnDuplicate,
} from "@/lib/employee-import";
import { primaryButton, secondaryButton } from "../modal";

const STATUS_STYLE: Record<ImportRow["status"], string> = {
  OK: "bg-green-100 text-green-900",
  WARNING: "bg-amber-100 text-amber-900",
  ERROR: "bg-red-100 text-red-900",
};
const STATUS_TEXT: Record<ImportRow["status"], string> = {
  OK: "Зөв",
  WARNING: "Анхааруулга",
  ERROR: "Алдаа",
};
const ACTION_TEXT = { CREATE: "Нэмнэ", UPDATE: "Шинэчилнэ" } as const;

function save(text: string, fileName: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
  URL.revokeObjectURL(url);
}

/** Ажилтнуудыг Excel-ээр олноор нь оруулах (PRD 12.3): validate first, read the report, then import. */
export function ImportScreen() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<Mode>("VALID_ONLY");
  const [onDuplicate, setOnDuplicate] = useState<OnDuplicate>("SKIP");
  const [createAccounts, setCreateAccounts] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = (dryRun: boolean): ImportOptions => ({
    dryRun,
    mode,
    onDuplicate,
    createAccounts,
    fileName: file?.name ?? "",
  });

  async function go(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await runImport(file, options(dryRun)));
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "IMPORT_HAS_ERRORS" && e.extra) {
        setReport(e.extra as ImportReport);
        setError(
          "Файлд алдаа байгаа тул юу ч оруулсангүй («алдаатай бол зогсоох» сонголт). Алдааг засаад дахин шалгана уу.",
        );
      } else {
        setError(e instanceof ApiRequestError ? e.message : "Файлыг боловсруулж чадсангүй.");
      }
    } finally {
      setBusy(false);
    }
  }

  function choose(f: File | null) {
    setReport(null);
    setError(null);
    if (!f) return setFile(null);
    const problem = fileProblem(f);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(f);
  }

  async function template(format: "xlsx" | "csv") {
    try {
      const { blob, fileName } = await download(`/v1/employees/import/template?format=${format}`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Загвар татаж чадсангүй.");
    }
  }

  const rows = report
    ? onlyProblems
      ? report.rows.filter((r) => r.status !== "OK")
      : report.rows
    : [];
  const canCommit =
    report !== null && report.dryRun && (report.summary.ok > 0 || report.summary.errors === 0);

  return (
    <div>
      <Link href="/employees" className="inline-flex min-h-11 items-center text-teal-700 underline">
        ← Ажилтнууд
      </Link>
      <h1 className="text-2xl font-semibold">Excel-ээр оруулах</h1>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>
          Загвар татаж бөглөнө.{" "}
          <button
            type="button"
            className="text-teal-700 underline"
            onClick={() => void template("xlsx")}
          >
            Excel загвар
          </button>{" "}
          ·{" "}
          <button
            type="button"
            className="text-teal-700 underline"
            onClick={() => void template("csv")}
          >
            CSV загвар
          </button>
        </li>
        <li>
          Файлаа сонгоод «Шалгах» дарна. Энэ үед юу ч хадгалагдахгүй, мөр бүрийн үр дүн гарна.
        </li>
        <li>Тайланг шалгаад «Оруулах» дарна.</li>
      </ol>
      <p className="mt-2 text-sm text-slate-600">
        Код хоосон мөр шинэ ажилтан нэмнэ (16 оронтой кодыг систем өгнө). Кодтой мөр тэр ажилтныг
        шинэчилнэ; хоосон цол, албан тушаал, огноо, хуваарь нь хуучин утгыг хөндөхгүй. Нууц үг
        импортлогдохгүй.
      </p>

      <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <label className="block text-sm font-medium">
          Файл (.xlsx эсвэл .csv, ≤ 5 МБ, ≤ 2000 мөр)
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
            className="mt-1 block min-h-11 w-full text-sm"
          />
        </label>
        <fieldset className="mt-3 space-y-1 text-sm">
          <legend className="font-medium">Алдаатай мөр байвал</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              checked={mode === "VALID_ONLY"}
              onChange={() => setMode("VALID_ONLY")}
            />
            Зөв мөрүүдийг л оруулна
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              checked={mode === "ABORT_ON_ERROR"}
              onChange={() => setMode("ABORT_ON_ERROR")}
            />
            Нэг ч алдаа байвал юу ч оруулахгүй
          </label>
        </fieldset>
        <label className="mt-1 flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onDuplicate === "CREATE"}
            onChange={(e) => setOnDuplicate(e.target.checked ? "CREATE" : "SKIP")}
          />
          Нэр, нэгж нь ижил хүнийг ч шинээр нэмнэ (өөр хүн бол)
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={createAccounts}
            onChange={(e) => setCreateAccounts(e.target.checked)}
          />
          Шинэ ажилтан бүрт нэвтрэх эрх үүсгэнэ (нэг удаагийн нууц үг; нэг импортод ≤ {MAX_ACCOUNTS}{" "}
          хүн)
        </label>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!file || busy}
            className={secondaryButton}
            onClick={() => void go(true)}
          >
            Шалгах
          </button>
          <button
            type="button"
            disabled={!file || busy || !canCommit}
            className={primaryButton}
            onClick={() => void go(false)}
          >
            Оруулах
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {report && (
        <section className="mt-4" aria-label="Тайлан">
          <h2 className="text-lg font-semibold">
            {report.committed ? "Оруулсан үр дүн" : "Шалгалтын тайлан (юу ч хадгалаагүй)"}
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            Нийт {report.summary.total} мөр: зөв <b>{report.summary.ok}</b> · анхааруулга{" "}
            <b>{report.summary.warnings}</b> · алдаа <b>{report.summary.errors}</b>
            {report.committed ? (
              <>
                {" "}
                · нэмсэн <b>{report.summary.created}</b> · шинэчилсэн{" "}
                <b>{report.summary.updated}</b>
              </>
            ) : null}
          </p>

          {report.committed && (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => save(resultSheet(report), "import-result.csv")}
              >
                Үр дүнгийн хүснэгт (кодтой) татах
              </button>
              {report.credentials && report.credentials.length > 0 && (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => save(credentialsSheet(report), "logins.csv")}
                >
                  Нэвтрэх нууц үгийн хүснэгт татах
                </button>
              )}
            </div>
          )}
          {report.credentials && report.credentials.length > 0 && (
            <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
              Нууц үгийг дахин харах боломжгүй: энэ хуудсыг хаахаас өмнө хүснэгтийг татаж аваарай.
              Сервер хадгалахгүй.
            </p>
          )}

          <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            Зөвхөн алдаа, анхааруулгатай мөрийг харуулах
          </label>
          <div className="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  {["Мөр", "Ажилтан", "Код", "Үр дүн", "Тайлбар"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 text-slate-500">{r.row}</td>
                    <td className="px-3 py-2 font-medium">{r.fullName || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.employeeNo ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status]}`}
                      >
                        {STATUS_TEXT[r.status]}
                      </span>
                      {r.action && (
                        <span className="ml-1 text-xs text-slate-700">{ACTION_TEXT[r.action]}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {r.messages.map((m) => (
                        <div key={m.code}>{messageText(m)}</div>
                      ))}
                      {r.changes.map((c) => (
                        <div key={c.field}>
                          {fieldLabel(c.field)}:{" "}
                          <span className="text-slate-500">{c.from ?? "—"}</span> →{" "}
                          <b>{c.to ?? "—"}</b>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
