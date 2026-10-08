"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiRequestError, download } from "@/lib/api";
import { fetchDepartments, fetchLocations, type Option } from "@/lib/daily";
import {
  createBody,
  CONSENT_LABEL,
  emptyForm,
  employeesHref,
  fetchEmployees,
  fetchTitles,
  PAGE_SIZE,
  parseListState,
  STATUS_LABEL,
  type EmployeeListItem,
  type StatusFilter,
} from "@/lib/employees";
import type { SessionUser } from "@/lib/session";
import { fieldClass, secondaryButton } from "../modal";
import { EmployeeFormDialog } from "./employee-form";

const STATUSES: StatusFilter[] = ["ACTIVE", "DISABLED", "ARCHIVED", "ALL"];

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Ажилтнууд (PRD 12): the register of people, search and filters, add one, open one. */
export function EmployeesScreen({ user }: { user: SessionUser }) {
  const router = useRouter();
  const params = useSearchParams();
  const state = useMemo(() => parseListState(params), [params]);
  const canEdit = user.role === "ORG_ADMIN" || user.role === "HR";

  const [data, setData] = useState<{ total: number; items: EmployeeListItem[] } | null>(null);
  const [departments, setDepartments] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Option[]>([]);
  const [ranks, setRanks] = useState<string[]>([]);
  const [positions, setPositions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState(state.q);

  useEffect(() => {
    fetchDepartments().then(setDepartments, () => undefined);
    fetchLocations().then(setLocations, () => undefined);
    if (canEdit) {
      fetchTitles("rank").then(setRanks, () => undefined);
      fetchTitles("position").then(setPositions, () => undefined);
    }
  }, [canEdit]);

  const load = useCallback(async () => {
    try {
      setData(await fetchEmployees(state));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [state]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (search === state.q) return;
    const timer = setTimeout(
      () => router.replace(employeesHref({ ...state, q: search, page: 1 })),
      350,
    );
    return () => clearTimeout(timer);
  }, [search, state, router]);

  const go = (patch: Partial<typeof state>) =>
    router.push(employeesHref({ ...state, page: 1, ...patch }));
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  async function exportAs(format: "xlsx" | "csv" | "pdf") {
    try {
      const query = new URLSearchParams({ format, status: state.status });
      if (state.q.trim()) query.set("q", state.q.trim());
      if (state.departmentId) query.set("departmentId", state.departmentId);
      if (state.locationId) query.set("locationId", state.locationId);
      const { blob, fileName } = await download(`/v1/exports/employees?${query}`);
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement("a"), { href: url, download: fileName }).click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Ажилтнууд</h1>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Link
              href="/employees/import"
              className={`${secondaryButton} inline-flex items-center`}
            >
              Excel-ээр оруулах
            </Link>
            <button
              type="button"
              className="min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800"
              onClick={() => setAdding(true)}
            >
              + Ажилтан нэмэх
            </button>
          </div>
        )}
      </div>

      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Төлөвөөр шүүх">
        {STATUSES.map((s) => (
          <li key={s}>
            <button
              type="button"
              aria-pressed={state.status === s}
              onClick={() => go({ status: s })}
              className={`min-h-11 rounded-full border px-4 text-sm ${
                state.status === s
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium">
          Нэгж
          <select
            value={state.departmentId ?? ""}
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
          Салбар
          <select
            value={state.locationId ?? ""}
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
        <p className="text-sm text-slate-600">{data ? `${data.total} ажилтан` : "Ачаалж байна…"}</p>
        {canEdit && (
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

      {data && data.items.length === 0 && <p className="mt-4 text-slate-600">Ажилтан олдсонгүй.</p>}
      {data && data.items.length > 0 && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {[
                  "Код",
                  "Овог нэр",
                  "Цол",
                  "Албан тушаал",
                  "Нэгж",
                  "Салбар",
                  "Зөвшөөрөл",
                  "Утас",
                  "Төлөв",
                ].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{e.employeeNo}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/employees/${e.id}`}
                      className="font-medium text-teal-800 underline"
                    >
                      {e.fullName}
                    </Link>
                    {e.manualAttendance && (
                      <span className="ml-1 text-xs text-slate-600">· гараар</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{e.rank ?? "—"}</td>
                  <td className="px-3 py-2">{e.position ?? "—"}</td>
                  <td className="px-3 py-2">{e.departmentName}</td>
                  <td className="px-3 py-2">{e.locationName}</td>
                  <td className="px-3 py-2">
                    {e.consentStatus ? CONSENT_LABEL[e.consentStatus] : "—"}
                  </td>
                  <td className="px-3 py-2">{e.hasActiveDevice ? "Бүртгэлтэй" : "—"}</td>
                  <td className="px-3 py-2">{STATUS_LABEL[e.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <nav
          aria-label="Хуудаслалт"
          className="mt-3 flex items-center justify-between gap-2 text-sm"
        >
          <button
            type="button"
            className={secondaryButton}
            disabled={state.page <= 1}
            onClick={() => go({ page: state.page - 1 })}
          >
            ‹ Өмнөх
          </button>
          <span>
            {state.page} / {pages}
          </span>
          <button
            type="button"
            className={secondaryButton}
            disabled={state.page >= pages}
            onClick={() => go({ page: state.page + 1 })}
          >
            Дараах ›
          </button>
        </nav>
      )}

      {adding && (
        <EmployeeFormDialog
          title="Ажилтан нэмэх"
          initial={emptyForm}
          departments={departments}
          locations={locations}
          rankSuggestions={ranks}
          positionSuggestions={positions}
          submitLabel="Нэмэх"
          onClose={() => setAdding(false)}
          onSubmit={async (form) => {
            const created = await api<{ id: string; employeeNo: string; fullName: string }>(
              "/v1/employees",
              {
                method: "POST",
                body: createBody(form),
              },
            );
            setAdding(false);
            setMessage(`${created.fullName} нэмэгдлээ. Ажилтны код: ${created.employeeNo}`);
            await load();
          }}
        />
      )}
    </div>
  );
}
