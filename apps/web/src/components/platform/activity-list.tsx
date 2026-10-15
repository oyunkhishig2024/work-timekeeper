"use client";

import { useEffect, useState } from "react";
import { ACTION_TEXT, fetchActivity, platformErrorText, type ActivityRow } from "@/lib/platform";
import { FormError } from "../form-error";

const dateText = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Ulaanbaatar" }).slice(0, 16);

/** The Super Admin trail: sign-ins and every action on an organization (newest first). */
export function ActivityList() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetchActivity().then(setRows, (e) => setError(platformErrorText(e)));
  }, []);
  if (error) return <FormError message={error} className="mt-4 text-sm text-red-700" />;
  if (rows === null) return <p className="mt-4 text-slate-600">Ачаалж байна…</p>;
  return (
    <ul className="mt-4 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 p-3 text-sm">
          <span>
            <b>{ACTION_TEXT[r.action] ?? r.action}</b>
            {r.orgCode && <span className="text-slate-600"> · {r.orgCode}</span>}
          </span>
          <span className="text-slate-600">
            {r.actorUsername ?? r.actorRole ?? "—"} · {dateText(r.occurredAt)}
          </span>
        </li>
      ))}
      {rows.length === 0 && <li className="p-3 text-sm text-slate-600">Бичлэг алга.</li>}
    </ul>
  );
}
