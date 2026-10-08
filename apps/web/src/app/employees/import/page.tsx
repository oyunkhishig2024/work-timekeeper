"use client";

import { AppShell } from "@/components/app-shell";
import { ImportScreen } from "@/components/employees/import-screen";

export default function EmployeeImportPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "ORG_ADMIN" || user.role === "HR" ? (
          <ImportScreen />
        ) : (
          <p className="text-slate-700">
            Ажилтан импортлохыг Байгууллагын админ, Хүний нөөц хийнэ.
          </p>
        )
      }
    </AppShell>
  );
}
