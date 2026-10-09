"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, download } from "@/lib/api";
import { fetchOrganization, formatTime, type Organization } from "@/lib/attendance";
import {
  departureText,
  fetchDepartments,
  fetchLocations,
  offDayLabel,
  type Option,
} from "@/lib/daily";
import {
  exportPath,
  fetchTimeReport,
  formatHm,
  parseReportsState,
  periodOf,
  reportsHref,
  shiftPeriod,
  timeReportQuery,
  type ReportKind,
  type TimeReport,
} from "@/lib/reports";
import { fieldClass, secondaryButton } from "../modal";

const KIND_LABEL: Record<ReportKind, string> = {
  short: "Дутуу цаг",
  overtime: "Илүү цаг",
  offday: "Баяр, амралтын өдөр ажилласан",
};
const btn =
  "min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100";

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Дутуу цаг, илүү цагийн тайлан: a week or a month, per employee, with the same numbers in Excel / CSV / PDF (PRD 9, 23.2). */
export function ReportsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => parseReportsState(params), [params]);
  const [org, setOrg] = useState<Organization | null>(null);
  const [locations, setLocations] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [report, setReport] = useState<TimeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    fetchOrganization().then(setOrg, (e) => setError(errorText(e)));
    fetchLocations().then(setLocations, () => undefined);
    fetchDepartments().then(setDepartments, () => undefined);
  }, []);

  const anchor = state.date ?? org?.today ?? null;
  const range = anchor ? periodOf(state.period, anchor) : null;
  const { kind, locationId, departmentId } = state;
  const from = range?.from;
  const to = range?.to;

  useEffect(() => {
    if (!from || !to) return;
    const mine = ++request.current;
    setReport(null);
    fetchTimeReport(timeReportQuery({ kind, locationId, departmentId }, { from, to }), kind).then(
      (r) => {
        if (request.current === mine) {
          setReport(r);
          setError(null);
        }
      },
      (e) => request.current === mine && setError(errorText(e)),
    );
  }, [from, to, kind, locationId, departmentId]);

  const go = (patch: Partial<typeof state>) => router.push(reportsHref({ ...state, ...patch }));

  async function exportAs(format: "xlsx" | "csv" | "pdf") {
    if (!range) return;
    try {
      const { blob, fileName } = await download(exportPath(state, range, format));
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const short = kind === "short";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Тайлан</h1>
        {org && <p className="text-sm text-slate-600">{org.name}</p>}
      </div>

      <ul className="mt-4 flex gap-2" aria-label="Тайлангийн төрөл">
        {(["short", "overtime", "offday"] as const).map((k) => (
          <li key={k}>
            <button
              type="button"
              aria-pressed={kind === k}
              onClick={() => go({ kind: k })}
              className={`min-h-11 rounded-full border px-4 text-sm ${
                kind === k
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          </li>
        ))}
      </ul>

      {anchor && range && org && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={state.period === p}
              onClick={() => go({ period: p })}
              className={`${btn} ${state.period === p ? "border-teal-700 bg-teal-50" : ""}`}
            >
              {p === "week" ? "7 хоног" : "Сар"}
            </button>
          ))}
          <button
            type="button"
            className={btn}
            aria-label="Өмнөх"
            onClick={() => go({ date: shiftPeriod(state.period, anchor, -1) })}
          >
            ‹ Өмнөх
          </button>
          <button
            type="button"
            className={btn}
            disabled={state.date === null}
            onClick={() => go({ date: null })}
          >
            Энэ {state.period === "week" ? "7 хоног" : "сар"}
          </button>
          <button
            type="button"
            className={btn}
            aria-label="Дараах"
            onClick={() => go({ date: shiftPeriod(state.period, anchor, 1) })}
          >
            Дараах ›
          </button>
          <span className="ml-auto text-sm text-slate-700">
            {range.from} — {range.to}
          </span>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Салбар
          <select
            value={locationId ?? ""}
            onChange={(e) => go({ locationId: e.target.value || null })}
            className={fieldClass}
          >
            <option value="">Бүх салбар</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Нэгж
          <select
            value={departmentId ?? ""}
            onChange={(e) => go({ departmentId: e.target.value || null })}
            className={fieldClass}
          >
            <option value="">Бүх нэгж</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {report ? `${report.total} ажилтан` : "Ачаалж байна…"}
        </p>
        <div className="flex gap-2">
          {(["xlsx", "csv", "pdf"] as const).map((format) => (
            <button
              key={format}
              type="button"
              className={`${secondaryButton} text-sm`}
              onClick={() => void exportAs(format)}
            >
              {format === "xlsx" ? "Excel" : format.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {report && report.items.length === 0 && (
        <p className="mt-4 text-slate-600">
          {short
            ? "Энэ хугацаанд дутуу цагтай ажилтан алга."
            : "Энэ хугацаанд илүү цагтай ажилтан алга."}
        </p>
      )}
      {report && report.items.length > 0 && kind === "offday" && org && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {[
                  "Огноо",
                  "Ажилтан",
                  "Нэгж",
                  "Өдрийн төрөл",
                  "Ирсэн цаг",
                  "Гарсан цаг",
                  "Тайлбар",
                ].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.items.map((r) => (
                <tr
                  key={`${r.employeeId}-${r.date}`}
                  className="border-t border-slate-100 align-top"
                >
                  <td className="px-3 py-2">{r.date}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.fullName}</div>
                    <div className="text-xs text-slate-500">{r.employeeNo}</div>
                  </td>
                  <td className="px-3 py-2">{r.departmentName ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.offDayKind === "HOLIDAY" ? "Баярын өдөр" : "Амралтын өдөр"}
                  </td>
                  <td className="px-3 py-2">{formatTime(r.arrivalAt, org.timeZone) ?? "—"}</td>
                  <td className="px-3 py-2">
                    {departureText(r, (iso) => formatTime(iso, org.timeZone))}
                  </td>
                  <td className="px-3 py-2">{offDayLabel(r.offDayKind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report && report.items.length > 0 && kind !== "offday" && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {(short
                  ? [
                      "Ажилтан",
                      "Нэгж",
                      "Ирсэн / ажиллах өдөр",
                      "Хоцорсон",
                      "Эрт гарсан",
                      "Дутуу цаг",
                      "Ирээгүй",
                    ]
                  : ["Ажилтан", "Нэгж", "Ирсэн өдөр", "Илүү цагтай өдөр", "Илүү цаг"]
                ).map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.items.map((r) => (
                <tr key={r.employeeId} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.fullName}</div>
                    <div className="text-xs text-slate-500">
                      {[r.rank, r.position].filter(Boolean).join(" · ") || r.employeeNo}
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.departmentName ?? "—"}</td>
                  {short ? (
                    <>
                      <td className="px-3 py-2">
                        {r.attendedDays} / {r.expectedDays}
                      </td>
                      <td className="px-3 py-2">
                        {r.lateDays > 0 ? `${r.lateDays} өдөр · ${formatHm(r.lateMinutes)}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {r.earlyLeaveDays > 0
                          ? `${r.earlyLeaveDays} өдөр · ${formatHm(r.earlyLeaveMinutes)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 font-medium">{formatHm(r.shortMinutes)}</td>
                      <td className="px-3 py-2">
                        {r.noShowDays > 0 ? `${r.noShowDays} өдөр` : "—"}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2">{r.attendedDays}</td>
                      <td className="px-3 py-2">{r.overtimeDays}</td>
                      <td className="px-3 py-2 font-medium">{formatHm(r.overtimeMinutes)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-600">
        {kind === "offday"
          ? "Амралтын өдөр эсвэл баярын өдөр ирсэн ажилтан: ирсэн, гарсан цагийг тэмдэглэнэ. Илүү цаг, дутуу цагт тооцохгүй; цааш яахыг Хүний нөөц шийднэ."
          : short
            ? "Дутуу цаг = хоцорсон минут + эрт гарсан минут. Ирээгүй өдрийг минутаар биш өдрөөр тоолно. Цаг: ц:мм."
            : "Илүү цаг = ажил тарснаас хойш, зөвшөөрөгдөх хугацаанаас (дүрэм, анхдагч 15 мин) илүү байсан минут. Цаг: ц:мм."}
      </p>
    </div>
  );
}
