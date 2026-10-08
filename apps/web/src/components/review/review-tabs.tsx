"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchAlerts, fetchAnomalies } from "@/lib/review";

/** The two review lists of HR, each with the number of open items. */
export function ReviewTabs({ refresh }: { refresh?: number }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<{ anomalies: number | null; alerts: number | null }>({
    anomalies: null,
    alerts: null,
  });
  useEffect(() => {
    let alive = true;
    void Promise.all([
      fetchAnomalies({ status: "OPEN", employeeId: null }).then(
        (r) => r.total,
        () => null,
      ),
      fetchAlerts("OPEN").then(
        (r) => r.total,
        () => null,
      ),
    ]).then(([anomalies, alerts]) => alive && setCounts({ anomalies, alerts }));
    return () => {
      alive = false;
    };
  }, [refresh]);

  const tab = (href: string, label: string, n: number | null) => (
    <Link
      href={href}
      aria-current={pathname === href ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
        pathname === href
          ? "border-teal-700 bg-teal-700 text-white"
          : "border-slate-300 bg-white hover:bg-slate-100"
      }`}
    >
      {label}
      {n !== null && n > 0 ? (
        <span className="ml-2 rounded-full bg-white/90 px-2 text-xs text-slate-900">{n}</span>
      ) : null}
    </Link>
  );
  return (
    <nav aria-label="Хяналтын жагсаалт" className="mt-3 flex flex-wrap gap-2">
      {tab("/review", "Сэжигтэй event", counts.anomalies)}
      {tab("/device-alerts", "Төхөөрөмжийн сэрэмжлүүлэг", counts.alerts)}
    </nav>
  );
}
