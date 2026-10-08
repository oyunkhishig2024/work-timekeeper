"use client";

import { AppShell } from "@/components/app-shell";
import { EmployeeDetailScreen } from "@/components/employees/employee-detail";

export default function EmployeePage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "EMPLOYEE" ? (
          <p className="text-slate-700">
            Ажилтны мэдээллийг Байгууллагын админ, Хүний нөөц, Менежер үзнэ.
          </p>
        ) : (
          <EmployeeDetailScreen user={user} />
        )
      }
    </AppShell>
  );
}
