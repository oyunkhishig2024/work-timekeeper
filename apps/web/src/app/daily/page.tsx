"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { DailyScreen } from "@/components/daily/daily-screen";

export default function DailyPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">
            Өдрийн ирцийг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.
          </p>
        ) : (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <DailyScreen user={user} />
          </Suspense>
        )
      }
    </AppShell>
  );
}
