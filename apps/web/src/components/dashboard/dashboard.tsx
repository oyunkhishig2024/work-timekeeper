"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError } from "@/lib/api";
import {
  dashboardHref,
  fetchDaily,
  fetchOrganization,
  fetchSummary,
  parseDashboardState,
  type DailyRow,
  type Organization,
  type Summary,
} from "@/lib/attendance";
import { DateNav } from "./date-nav";
import { Breakdown, SummaryCards } from "./overview";
import { PeopleList } from "./people-list";

const REFRESH_MS = 60_000;

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Хянах самбар (PRD 7, 8): the day's totals, the branch / department breakdown, and the lists behind every number. */
export function Dashboard() {
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => parseDashboardState(params), [params]);
  const [org, setOrg] = useState<Organization | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    fetchOrganization().then(setOrg, (e) => setError(errorText(e)));
  }, []);

  const date = state.date ?? org?.today ?? null;
  const isToday = org !== null && date === org.today;
  const { status, locationId, departmentId } = state;

  // The numbers; today's are refreshed every minute because the worker keeps moving people from "not yet" to "no show".
  useEffect(() => {
    if (!date) return;
    let alive = true;
    const load = () =>
      fetchSummary(date).then(
        (s) => {
          if (!alive) return;
          setSummary(s);
          setError(null);
        },
        (e) => alive && setError(errorText(e)),
      );
    setSummary(null);
    void load();
    const timer = isToday ? setInterval(() => void load(), REFRESH_MS) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [date, isToday]);

  // The list behind a number.
  useEffect(() => {
    if (!date || !status) {
      setRows(null);
      return;
    }
    const mine = ++request.current;
    setRows(null);
    fetchDaily({ date, status, locationId, departmentId }).then(
      (r) => {
        if (request.current === mine) setRows(r.items);
      },
      (e) => request.current === mine && setError(errorText(e)),
    );
  }, [date, status, locationId, departmentId, summary?.total]);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Хянах самбар</h1>
        {org && <p className="text-sm text-slate-600">{org.name}</p>}
      </div>
      {org && date && (
        <div className="mt-3">
          <DateNav
            date={date}
            today={org.today}
            onChange={(next) =>
              router.push(dashboardHref({ ...state, date: next === org.today ? null : next }))
            }
          />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <div className="mt-4">
        {!summary && !error && <p className="text-slate-600">Ачаалж байна…</p>}
        {summary && org && !status && (
          <>
            <SummaryCards summary={summary} state={state} />
            <Breakdown summary={summary} state={state} />
          </>
        )}
        {summary && org && status && (
          <PeopleList state={state} summary={summary} rows={rows} timeZone={org.timeZone} loading />
        )}
      </div>
    </div>
  );
}
