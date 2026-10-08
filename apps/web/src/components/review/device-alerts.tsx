"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "@/lib/api";
import { fetchOrganization, type Organization } from "@/lib/attendance";
import {
  ALERT_LABEL,
  alertDetailText,
  fetchAlerts,
  resolveAlert,
  type DeviceAlert,
} from "@/lib/review";
import { secondaryButton } from "../modal";
import { NoteDialog } from "./note-dialog";
import { ReviewTabs } from "./review-tabs";

const dateTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

function errorText(e: unknown): string {
  return e instanceof ApiRequestError
    ? e.message
    : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";
}

/** Device alerts (PRD 6.7): attestation silent for five batches, one device or movement shared by two employees. */
export function DeviceAlerts() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [status, setStatus] = useState<"OPEN" | "ALL">("OPEN");
  const [items, setItems] = useState<DeviceAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<DeviceAlert | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    fetchOrganization().then(setOrg, (e) => setError(errorText(e)));
  }, []);
  const load = useCallback(async () => {
    try {
      setItems((await fetchAlerts(status)).items);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [status]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Хяналт</h1>
      <ReviewTabs refresh={version} />
      <p className="mt-4 text-sm text-slate-700">
        Нэг төхөөрөмж дараалан баталгаажаагүй, эсвэл нэг төхөөрөмж / ижил хөдөлгөөн хоёр ажилтны
        нэрээр илэрсэн тохиолдол. Шалгаад «Шийдсэн» болгоно.
      </p>
      <ul className="mt-3 flex gap-2" aria-label="Төлөвөөр шүүх">
        {(["OPEN", "ALL"] as const).map((s) => (
          <li key={s}>
            <button
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-11 rounded-full border px-4 text-sm ${
                status === s
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white hover:bg-slate-100"
              }`}
            >
              {s === "OPEN" ? "Нээлттэй" : "Бүгд"}
            </button>
          </li>
        ))}
      </ul>
      {(error || message) && (
        <p
          role={error ? "alert" : "status"}
          className={`mt-3 rounded-md p-3 text-sm ${error ? "bg-red-50 text-red-800" : "bg-teal-50 text-teal-900"}`}
        >
          {error ?? message}
        </p>
      )}
      {!items && !error && <p className="mt-4 text-slate-600">Ачаалж байна…</p>}
      {items && items.length === 0 && (
        <p className="mt-4 text-slate-600">Сэрэмжлүүлэг байхгүй байна.</p>
      )}
      {items && org && (
        <ul className="mt-4 space-y-3">
          {items.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{ALERT_LABEL[a.kind]}</p>
                  <p className="text-sm text-slate-700">
                    {a.fullName} <span className="text-slate-500">{a.employeeNo}</span>
                    {a.relatedFullName ? (
                      <>
                        {" "}
                        ↔ {a.relatedFullName}{" "}
                        <span className="text-slate-500">{a.relatedEmployeeNo}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${a.resolvedAt ? "bg-green-100 text-green-900" : "bg-amber-100 text-amber-900"}`}
                >
                  {a.resolvedAt ? "Шийдсэн" : "Нээлттэй"}
                </span>
              </div>
              {a.detail && (
                <p className="mt-2 text-sm text-slate-700">{alertDetailText(a.detail)}</p>
              )}
              <p className="mt-1 text-xs text-slate-600">
                {a.platform === "IOS" ? "iPhone" : "Android"}
                {a.model ? ` · ${a.model}` : ""} · {dateTime(a.createdAt, org.timeZone)}
                {a.kind === "ATTESTATION_UNAVAILABLE_STREAK"
                  ? ` · дараалсан ${a.unavailableStreak}`
                  : ""}
              </p>
              {a.resolvedAt && (
                <p className="mt-1 text-xs text-slate-600">
                  {a.resolvedByName} · {dateTime(a.resolvedAt, org.timeZone)}
                  {a.resolutionNote ? ` · «${a.resolutionNote}»` : ""}
                </p>
              )}
              {!a.resolvedAt && (
                <div className="mt-3">
                  <button type="button" className={secondaryButton} onClick={() => setResolving(a)}>
                    Шийдсэн болгох
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {resolving && (
        <NoteDialog
          title="Сэрэмжлүүлгийг шийдсэн болгох"
          intro={`${ALERT_LABEL[resolving.kind]} · ${resolving.fullName}`}
          label="Юу хийсэн бэ"
          required={false}
          submitLabel="Шийдсэн"
          onSubmit={async (note) => {
            try {
              await resolveAlert(resolving.id, note);
            } catch (e) {
              throw new Error(errorText(e));
            }
            setResolving(null);
            setMessage("Шийдсэн гэж тэмдэглэлээ.");
            setVersion((v) => v + 1);
            await load();
          }}
          onClose={() => setResolving(null)}
        />
      )}
    </div>
  );
}
