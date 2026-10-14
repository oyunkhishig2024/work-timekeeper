"use client";

import { type ReactNode } from "react";
import { type HistoryRow } from "@/lib/employees";

export function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

export function History({ rows, field }: { rows: HistoryRow[]; field: "rank" | "position" }) {
  if (rows.length === 0) return <p className="text-slate-600">Бүртгэл байхгүй.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.id} className="py-1.5">
          <b>{r[field]}</b>
          <span className="text-slate-600">
            {" "}
            · {r.validFrom} → {r.validTo ?? "одоог хүртэл"}
          </span>
          {r.note && <div className="text-xs text-slate-600">{r.note}</div>}
        </li>
      ))}
    </ul>
  );
}
