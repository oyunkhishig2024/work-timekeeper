"use client";

import Link from "next/link";
import {
  barSegments,
  countFor,
  dashboardHref,
  rateFor,
  STATUS_LABEL,
  type Bucket,
  type DashboardState,
  type Figures,
  type Status,
  type Summary,
} from "@/lib/attendance";
import { STATUS_STYLE } from "./status-ui";

const QUICK: Status[] = ["ON_TIME", "LATE", "EXCUSED", "NO_SHOW"];
const PILLS: Status[] = ["ON_TIME", "LATE", "EXCUSED", "NO_SHOW"];

const pct = (n: number) => `${n.toFixed(1)}%`;

/** The four quick cards and the total card (PRD 7). Each opens the list of people behind the number. */
export function SummaryCards({ summary, state }: { summary: Summary; state: DashboardState }) {
  const base = { date: state.date, by: state.by };
  return (
    <section aria-label="Өнөөдрийн нэгтгэл">
      <Link
        href={dashboardHref({ ...base, status: "EXPECTED" })}
        className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-teal-600"
        aria-label={`Ажиллах ёстой ${summary.total} — жагсаалт харах`}
      >
        <span className="text-sm text-slate-600">Ажиллах ёстой</span>
        <span className="mt-1 block text-4xl font-bold">{summary.total}</span>
        <span className="mt-1 block text-sm text-slate-600">
          цагтаа + хоцорсон + шалтгаантай + ирээгүй
          {summary.pending > 0 ? ` · ирэх цаг болоогүй ${summary.pending}` : ""}
        </span>
      </Link>
      <Notes summary={summary} />
      <ul className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {QUICK.map((status) => {
          const rate = rateFor(summary, status);
          return (
            <li key={status}>
              <Link
                href={dashboardHref({ ...base, status })}
                className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-teal-600"
                aria-label={`${STATUS_LABEL[status]} ${countFor(summary, status)} — жагсаалт харах`}
              >
                <span className="text-sm text-slate-600">{STATUS_LABEL[status]}</span>
                <span className={`mt-1 block text-3xl font-bold ${STATUS_STYLE[status].text}`}>
                  {countFor(summary, status)}
                </span>
                <span className="mt-1 block text-sm text-slate-600">
                  {rate === null ? "" : pct(rate)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Notes({ summary }: { summary: Summary }) {
  const notes: string[] = [];
  if (summary.total === 0)
    notes.push("Энэ өдөр ажиллах ёстой хүн байхгүй (амралт, баяр эсвэл хуваарьгүй).");
  if (summary.workedOffDay > 0) notes.push(`Амралтын өдөр ажилласан: ${summary.workedOffDay}`);
  if (summary.notConfigured > 0)
    notes.push(`Тохиргоо дутуу (тоонд ороогүй): ${summary.notConfigured}`);
  if (summary.flagged > 0)
    notes.push(`⚑ ${summary.flagged} өдөр шалгах event-тэй, тоо өөрчлөгдөж болно`);
  if (summary.corrected > 0) notes.push(`Гараар засварласан: ${summary.corrected}`);
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

function StackedBar({ figures }: { figures: Figures }) {
  const segments = barSegments(figures);
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
      role="img"
      aria-label="Ирцийн хуваарилалт"
    >
      {segments.map((s) => (
        <div key={s.key} className={STATUS_STYLE[s.key].bar} style={{ width: `${s.percent}%` }} />
      ))}
    </div>
  );
}

/** Attendance by branch or by department (PRD 8): counts, on-time rate and one pill per status that opens that list. */
export function Breakdown({ summary, state }: { summary: Summary; state: DashboardState }) {
  const rows: Bucket[] = state.by === "department" ? summary.byDepartment : summary.byLocation;
  const scopeKey = state.by === "department" ? "departmentId" : "locationId";
  const tab = (by: "location" | "department", label: string) => (
    <Link
      href={dashboardHref({ date: state.date, by })}
      aria-current={state.by === by ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
        state.by === by
          ? "border-teal-700 bg-teal-700 text-white"
          : "border-slate-300 bg-white hover:bg-slate-100"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <section aria-labelledby="breakdown-title" className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="breakdown-title" className="text-lg font-semibold">
          {state.by === "department" ? "Нэгжээр" : "Салбараар"}
        </h2>
        <div className="flex gap-2">
          {tab("location", "Салбар")}
          {tab("department", "Нэгж")}
        </div>
      </div>
      {rows.length === 0 && <p className="mt-3 text-sm text-slate-600">Харуулах мэдээлэл алга.</p>}
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.id ?? "none"} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">
                {r.name ?? (state.by === "department" ? "Нэгжгүй" : "Салбаргүй")}
              </h3>
              <p className="text-sm text-slate-700">
                Ажиллах ёстой <b>{r.total}</b> · Цагтаа ирсэн <b>{pct(r.onTimeRate)}</b> ({r.onTime}{" "}
                / {r.total})
              </p>
            </div>
            <div className="mt-2">
              <StackedBar figures={r} />
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {PILLS.map((status) => {
                const n = countFor(r, status);
                const rate = rateFor(r, status);
                const inner = (
                  <span>
                    {STATUS_LABEL[status]} <b>{n}</b>
                    {rate !== null && n > 0 ? (
                      <span className="opacity-80"> · {pct(rate)}</span>
                    ) : null}
                  </span>
                );
                const cls = `inline-flex min-h-11 items-center rounded-full px-4 text-sm ${STATUS_STYLE[status].badge}`;
                return (
                  <li key={status}>
                    {r.id && n > 0 ? (
                      <Link
                        href={dashboardHref({
                          date: state.date,
                          status,
                          by: state.by,
                          [scopeKey]: r.id,
                        })}
                        className={`${cls} hover:ring-2 hover:ring-teal-600`}
                        aria-label={`${r.name} — ${STATUS_LABEL[status]} ${n} — жагсаалт харах`}
                      >
                        {inner}
                      </Link>
                    ) : (
                      <span className={`${cls} opacity-60`}>{inner}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
