"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard/dashboard";

export default function DashboardPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">
            Хянах самбарыг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.
          </p>
        ) : (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <Dashboard />
          </Suspense>
        )
      }
    </AppShell>
  );
}
