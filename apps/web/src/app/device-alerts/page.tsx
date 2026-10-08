"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { DeviceAlerts } from "@/components/review/device-alerts";

export default function Page() {
  return (
    <AppShell>
      {(user) =>
        user.role === "ORG_ADMIN" || user.role === "HR" ? (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <DeviceAlerts />
          </Suspense>
        ) : (
          <p className="text-slate-700">Хяналтын жагсаалтыг Байгууллагын админ, Хүний нөөц үзнэ.</p>
        )
      }
    </AppShell>
  );
}
