"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ScheduleScreen } from "@/components/schedule/schedule-screen";

export default function SchedulePage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">
            Цагийн хуваарийг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.
          </p>
        ) : (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <ScheduleScreen user={user} />
          </Suspense>
        )
      }
    </AppShell>
  );
}
