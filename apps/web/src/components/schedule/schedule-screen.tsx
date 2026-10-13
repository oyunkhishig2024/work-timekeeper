"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchOrganization, type Organization } from "@/lib/attendance";
import { fetchLocations, type Option } from "@/lib/daily";
import type { SessionUser } from "@/lib/session";
import { HolidaysSection } from "./holidays-section";
import { WeekSection } from "./week-section";

const TABS = [
  ["week", "Ажлын цаг, дүрэм"],
  ["holidays", "Баяр, онцгой өдөр"],
] as const;
type Tab = (typeof TABS)[number][0];

/** Working week, attendance rules, holidays and special days (PRD 14). Org Admin changes; HR and Manager read. */
export function ScheduleScreen({ user }: { user: SessionUser }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = params.get("tab") === "holidays" ? "holidays" : "week";
  const canEdit = user.role === "ORG_ADMIN";
  const [org, setOrg] = useState<Organization | null>(null);
  const [locations, setLocations] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [o, l] = await Promise.all([fetchOrganization(), fetchLocations()]);
        setOrg(o);
        setLocations(l);
      } catch {
        setError("Ачаалж чадсангүй. Дахин оролдоно уу.");
      }
    })();
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-semibold">Цагийн хуваарь</h1>
      {!canEdit && (
        <p className="mt-2 text-sm text-slate-600">
          Зөвхөн Байгууллагын админ өөрчилнө. Та үзэх эрхтэй.
        </p>
      )}
      <div role="tablist" className="mt-4 flex gap-1 border-b border-slate-200">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => router.replace(`/schedule?tab=${key}`)}
            className={`min-h-11 border-b-2 px-3 text-sm font-medium ${
              tab === key
                ? "border-teal-700 text-teal-800"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {!org ? (
          !error && <p className="text-slate-600">Ачаалж байна…</p>
        ) : tab === "week" ? (
          <WeekSection canEdit={canEdit} today={org.today} locations={locations} />
        ) : (
          <HolidaysSection canEdit={canEdit} today={org.today} locations={locations} />
        )}
      </div>
    </div>
  );
}
