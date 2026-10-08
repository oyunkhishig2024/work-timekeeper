"use client";

import Link from "next/link";
import {
  countFor,
  dashboardHref,
  explain,
  STATUS_LABEL,
  type Bucket,
  type DailyRow,
  type DashboardState,
  type Figures,
  type Status,
  type StatusFilter,
  type Summary,
} from "@/lib/attendance";
import { STATUS_STYLE } from "./status-ui";

const CHIPS: StatusFilter[] = ["EXPECTED", "ON_TIME", "LATE", "EXCUSED", "NO_SHOW"];

/** Who is behind a number: rank, name, position, department, branch, status and what happened that day. */
export function PeopleList({
  state,
  summary,
  rows,
  timeZone,
  loading,
}: {
  state: DashboardState;
  summary: Summary;
  rows: DailyRow[] | null;
  timeZone: string;
  loading: boolean;
}) {
  const status = state.status!;
  const bucket: Bucket | null =
    (state.locationId && summary.byLocation.find((b) => b.id === state.locationId)) ||
    (state.departmentId && summary.byDepartment.find((b) => b.id === state.departmentId)) ||
    null;
  const figures: Figures = bucket ?? summary;
  const scope = bucket?.name ?? null;
  const keep = {
    date: state.date,
    by: state.by,
    locationId: state.locationId,
    departmentId: state.departmentId,
  };

  return (
    <section aria-labelledby="list-title">
      <Link
        href={dashboardHref({ date: state.date, by: state.by })}
        className="inline-flex min-h-11 items-center text-teal-700 underline"
      >
        ← Хянах самбар
      </Link>
      <h2 id="list-title" className="mt-1 text-2xl font-semibold">
        {STATUS_LABEL[status]}
        {scope ? ` · ${scope}` : ""}
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Төлөв сонгох">
        {CHIPS.map((chip) => (
          <li key={chip}>
            <Link
              href={dashboardHref({ ...keep, status: chip })}
              aria-current={chip === status ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm ${
                chip === status
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {STATUS_LABEL[chip]} {countFor(figures, chip)}
            </Link>
          </li>
        ))}
      </ul>

      {loading && rows === null && <p className="mt-4 text-slate-600">Ачаалж байна…</p>}
      {rows && rows.length === 0 && (
        <p className="mt-4 text-slate-600">Энэ жагсаалт хоосон байна.</p>
      )}
      {rows && rows.length > 0 && (
        <>
          <p className="mt-4 text-sm text-slate-600">{rows.length} хүн</p>
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  {[
                    "№",
                    "Цол",
                    "Овог нэр",
                    "Албан тушаал",
                    "Нэгж",
                    "Салбар",
                    "Төлөв",
                    "Тайлбар",
                  ].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.employeeId} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-2">{r.rank ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{r.fullName}</td>
                    <td className="px-3 py-2">{r.position ?? "—"}</td>
                    <td className="px-3 py-2">{r.departmentName ?? "—"}</td>
                    <td className="px-3 py-2">{r.locationName ?? "—"}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status} />
                      {r.source === "CORRECTED" && (
                        <span className="ml-1 text-xs text-slate-600">· Засварласан</span>
                      )}
                      {r.flaggedEvents > 0 && (
                        <span className="ml-1 text-xs text-slate-600">· ⚑ шалгах</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{explain(r, timeZone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: DailyRow["status"] }) {
  if (status === "WORKED_OFF_DAY" || status === "NOT_CONFIGURED") {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
        {status === "WORKED_OFF_DAY" ? "Амралтын өдөр ажилласан" : "Тохиргоо дутуу"}
      </span>
    );
  }
  const s: Status = status;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[s].badge}`}>
      {STATUS_LABEL[s]}
    </span>
  );
}
