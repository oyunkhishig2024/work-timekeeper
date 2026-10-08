"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, download } from "@/lib/api";
import {
  fetchOrganization,
  formatTime,
  STATUS_LABEL,
  type Organization,
  type Status,
} from "@/lib/attendance";
import {
  dailyHref,
  dailyQuery,
  FILTER_LABEL,
  fetchDailyList,
  fetchDepartments,
  fetchLocations,
  fetchReasons,
  isReasonAssignable,
  MAX_BULK_ASSIGN,
  parseDailyState,
  type DailyFilterStatus,
  type DailyItem,
  type DailyResponse,
  type Option,
  type Reason,
} from "@/lib/daily";
import type { SessionUser } from "@/lib/session";
import { DateNav } from "../dashboard/date-nav";
import { STATUS_STYLE } from "../dashboard/status-ui";
import { fieldClass, primaryButton, secondaryButton } from "../modal";
import { AssignReasonDialog } from "./assign-reason-dialog";
import { CorrectionDialog } from "./correction-dialog";

const CHIPS: DailyFilterStatus[] = [
  "EXPECTED",
  "ON_TIME",
  "LATE",
  "EXCUSED",
  "NO_SHOW",
  "INACTIVE",
];
const REFRESH_MS = 60_000;

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Өдрийн ирц (PRD 9): who is expected on a date, with filters, the reason and the correction, and an export of the same list. */
export function DailyScreen({ user }: { user: SessionUser }) {
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => parseDailyState(params), [params]);
  const canEdit = user.role === "ORG_ADMIN" || user.role === "HR";
  const canExport = canEdit; // a Manager only when the Org Admin allowed it; the server decides, so the button is simply not offered

  const [org, setOrg] = useState<Organization | null>(null);
  const [data, setData] = useState<DailyResponse | null>(null);
  const [locations, setLocations] = useState<Option[]>([]);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assign, setAssign] = useState<DailyItem[] | null>(null);
  // Ticked employees are kept as whole rows so they stay visible (and selected) while the filters change.
  const [selected, setSelected] = useState<Map<string, DailyItem>>(new Map());
  const [correct, setCorrect] = useState<DailyItem | null>(null);
  const [search, setSearch] = useState(state.q);
  const request = useRef(0);

  useEffect(() => {
    fetchOrganization().then(setOrg, (e) => setError(errorText(e)));
    fetchLocations().then(setLocations, () => undefined);
    fetchDepartments().then(setDepartments, () => undefined);
    if (canEdit) fetchReasons().then(setReasons, () => undefined);
  }, [canEdit]);

  const date = state.date ?? org?.today ?? null;
  const isToday = org !== null && date === org.today;
  const { status, locationId, departmentId, q } = state;

  const load = useCallback(async () => {
    if (!date) return;
    const mine = ++request.current;
    try {
      const result = await fetchDailyList({
        date,
        status: status ?? undefined,
        locationId,
        departmentId,
        q,
      });
      if (request.current === mine) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (request.current === mine) setError(errorText(e));
    }
  }, [date, status, locationId, departmentId, q]);

  useEffect(() => {
    void load();
    const timer = isToday ? setInterval(() => void load(), REFRESH_MS) : null;
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [load, isToday]);

  // The search box writes to the URL a moment after typing stops.
  useEffect(() => {
    if (search === state.q) return;
    const timer = setTimeout(() => router.replace(dailyHref({ ...state, q: search })), 350);
    return () => clearTimeout(timer);
  }, [search, state, router]);

  const go = (patch: Partial<typeof state>) => router.push(dailyHref({ ...state, ...patch }));

  async function exportAs(format: "xlsx" | "csv" | "pdf") {
    if (!date) return;
    setMessage(null);
    try {
      const query = new URLSearchParams(
        dailyQuery({ date, status: status ?? undefined, locationId, departmentId, q }),
      );
      query.delete("limit");
      if (query.get("status") === "INACTIVE") query.delete("status"); // the export lists the day, not the derived indicator
      query.set("format", format);
      const { blob, fileName } = await download(`/v1/exports/daily-attendance?${query}`);
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  // A selection belongs to one date.
  useEffect(() => setSelected(new Map()), [date]);
  const toggle = (r: DailyItem) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.employeeId)) next.delete(r.employeeId);
      else if (next.size < MAX_BULK_ASSIGN) next.set(r.employeeId, r);
      return next;
    });
  const assignable = data?.items.filter(isReasonAssignable) ?? [];
  const allTicked = assignable.length > 0 && assignable.every((r) => selected.has(r.employeeId));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of assignable) {
        if (allTicked) next.delete(r.employeeId);
        else if (next.size < MAX_BULK_ASSIGN) next.set(r.employeeId, r);
      }
      return next;
    });

  const after = () => {
    setSelected(new Map());
    setAssign(null);
    setCorrect(null);
    setMessage("Хадгаллаа.");
    void load();
  };
  const active = status ?? "EXPECTED";

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Өдрийн ирц</h1>
        {org && <p className="text-sm text-slate-600">{org.name}</p>}
      </div>
      {org && date && (
        <div className="mt-3">
          <DateNav
            date={date}
            today={org.today}
            onChange={(next) => go({ date: next === org.today ? null : next })}
          />
        </div>
      )}

      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Төлөвөөр шүүх">
        {CHIPS.map((chip) => (
          <li key={chip}>
            <button
              type="button"
              aria-pressed={active === chip}
              onClick={() => go({ status: chip === "EXPECTED" ? null : chip })}
              className={`min-h-11 rounded-full border px-4 text-sm ${
                active === chip
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {FILTER_LABEL[chip]} {data ? data.counts[chip] : ""}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
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
        <label className="text-sm font-medium">
          Хайх (нэр, код)
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={fieldClass}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">{data ? `${data.total} хүн` : "Ачаалж байна…"}</p>
        {canExport && (
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
        )}
      </div>
      {(error || message) && (
        <p
          role={error ? "alert" : "status"}
          className={`mt-3 rounded-md p-3 text-sm ${error ? "bg-red-50 text-red-800" : "bg-teal-50 text-teal-900"}`}
        >
          {error ?? message}
        </p>
      )}

      {canEdit && selected.size > 0 && (
        <section
          aria-label="Сонгосон ажилтнууд"
          className="mt-3 rounded-lg border border-slate-200 bg-white p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${primaryButton} text-sm`}
              onClick={() => setAssign([...selected.values()])}
            >
              Шалтгаан оноох ({selected.size})
            </button>
            <button
              type="button"
              className={`${secondaryButton} text-sm`}
              onClick={() => setSelected(new Map())}
            >
              Бүгдийг болиулах
            </button>
            {selected.size >= MAX_BULK_ASSIGN && (
              <span className="text-xs text-slate-600">
                Нэг дор дээд тал нь {MAX_BULK_ASSIGN} хүн.
              </span>
            )}
          </div>
          <ul className="mt-2 flex max-h-32 flex-wrap gap-2 overflow-y-auto">
            {[...selected.values()].map((r) => (
              <li
                key={r.employeeId}
                className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 py-0.5 pl-3 pr-1 text-sm"
              >
                {r.fullName}
                <button
                  type="button"
                  aria-label={`${r.fullName} — сонголтоос хасах`}
                  className="h-8 w-8 rounded-full hover:bg-teal-100"
                  onClick={() => toggle(r)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.items.length === 0 && (
        <p className="mt-4 text-slate-600">Жагсаалт хоосон байна.</p>
      )}
      {data && data.items.length > 0 && org && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {canEdit && (
                  <th scope="col" className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Бүгдийг сонгох"
                      className="h-5 w-5"
                      checked={allTicked}
                      disabled={assignable.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                {[
                  "Ажилтан",
                  "Нэгж",
                  "Үндсэн салбар",
                  "Ажиллах салбар",
                  "Төлөв",
                  "Ирсэн цаг",
                  "Хоцорсон",
                  "Шалтгаан",
                  "",
                ].map((h, i) => (
                  <th key={i} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <Row
                  key={r.employeeId}
                  row={r}
                  timeZone={org.timeZone}
                  canEdit={canEdit}
                  onAssign={(r) => setAssign([r])}
                  ticked={selected.has(r.employeeId)}
                  onTick={toggle}
                  onCorrect={setCorrect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assign && date && (
        <AssignReasonDialog
          rows={assign}
          date={date}
          reasons={reasons}
          onClose={() => setAssign(null)}
          onSaved={after}
        />
      )}
      {correct && date && org && (
        <CorrectionDialog
          row={correct}
          date={date}
          timeZone={org.timeZone}
          onClose={() => setCorrect(null)}
          onSaved={after}
        />
      )}
    </div>
  );
}

function Row({
  row: r,
  timeZone,
  canEdit,
  onAssign,
  onCorrect,
  ticked,
  onTick,
}: {
  row: DailyItem;
  timeZone: string;
  canEdit: boolean;
  onAssign: (r: DailyItem) => void;
  onCorrect: (r: DailyItem) => void;
  ticked: boolean;
  onTick: (r: DailyItem) => void;
}) {
  const expected = r.status !== "WORKED_OFF_DAY" && r.status !== "NOT_CONFIGURED";
  const label = expected
    ? STATUS_LABEL[r.status as Status]
    : r.status === "WORKED_OFF_DAY"
      ? "Амралтын өдөр ажилласан"
      : "Тохиргоо дутуу";
  const lastSeen = formatTime(r.lastSeenAt, timeZone);
  return (
    <tr className={`border-t border-slate-100 align-top ${ticked ? "bg-teal-50" : ""}`}>
      {canEdit && (
        <td className="px-3 py-2">
          {isReasonAssignable(r) && (
            <input
              type="checkbox"
              aria-label={`${r.fullName} сонгох`}
              className="h-5 w-5"
              checked={ticked}
              onChange={() => onTick(r)}
            />
          )}
        </td>
      )}
      <td className="px-3 py-2">
        <div className="font-medium">{r.fullName}</div>
        <div className="text-xs text-slate-500">
          {[r.rank, r.position].filter(Boolean).join(" · ") || r.employeeNo}
        </div>
      </td>
      <td className="px-3 py-2">{r.departmentName ?? "—"}</td>
      <td className="px-3 py-2">{r.primaryLocationName ?? "—"}</td>
      <td className="px-3 py-2">
        {r.locationName ?? "—"}
        {r.temporary && (
          <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-900">
            Түр
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            expected ? STATUS_STYLE[r.status as Status].badge : "bg-slate-100 text-slate-800"
          }`}
        >
          {label}
        </span>
        {r.source === "CORRECTED" && <div className="mt-1 text-xs text-slate-600">Засварласан</div>}
        {r.flaggedEvents > 0 && <div className="mt-1 text-xs text-slate-600">⚑ шалгах</div>}
        {r.locationInactive && (
          <div className="mt-1 text-xs text-orange-800">
            Байршил идэвхгүй · {lastSeen ? `сүүлд ${lastSeen}` : "утас холбогдоогүй"}
          </div>
        )}
      </td>
      <td className="px-3 py-2">{formatTime(r.arrivalAt, timeZone) ?? "—"}</td>
      <td className="px-3 py-2">
        {r.status === "LATE" && r.lateMinutes > 0 ? `${r.lateMinutes} мин` : "—"}
      </td>
      <td className="px-3 py-2">
        {r.reasonName ? (
          <>
            {r.reasonName}
            {r.reasonNote && <div className="text-xs text-slate-600">{r.reasonNote}</div>}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2">
        {canEdit && expected && (
          <div className="flex flex-wrap gap-1">
            {!r.reasonName && (
              <button
                type="button"
                className="min-h-11 rounded-md border border-slate-300 px-3 hover:bg-slate-100"
                onClick={() => onAssign(r)}
              >
                Шалтгаан
              </button>
            )}
            <button
              type="button"
              className="min-h-11 rounded-md border border-slate-300 px-3 hover:bg-slate-100"
              onClick={() => onCorrect(r)}
            >
              Засах
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
