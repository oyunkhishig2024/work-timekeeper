"use client";

import { AppShell } from "@/components/app-shell";
import { UsersScreen } from "@/components/users/users-screen";

export default function UsersPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "ORG_ADMIN" ? (
          <UsersScreen user={user} />
        ) : (
          <p className="text-slate-700">Хэрэглэгчдийг зөвхөн Байгууллагын админ удирдана.</p>
        )
      }
    </AppShell>
  );
}
