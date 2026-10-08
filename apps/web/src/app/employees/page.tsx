"use client";

import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { EmployeesScreen } from "@/components/employees/employees-screen";

export default function EmployeesPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">
            Ажилтнуудын жагсаалтыг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.
          </p>
        ) : (
          <Suspense fallback={<p className="text-slate-600">Ачаалж байна…</p>}>
            <EmployeesScreen user={user} />
          </Suspense>
        )
      }
    </AppShell>
  );
}
