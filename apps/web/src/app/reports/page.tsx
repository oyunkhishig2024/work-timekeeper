"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ReportsScreen } from "@/components/reports/reports-screen";

export default function ReportsPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">Тайланг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.</p>
        ) : (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <ReportsScreen />
          </Suspense>
        )
      }
    </AppShell>
  );
}
