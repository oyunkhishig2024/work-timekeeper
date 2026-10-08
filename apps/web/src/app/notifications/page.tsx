"use client";

import { AppShell } from "@/components/app-shell";
import { Inbox } from "@/components/inbox";
import { PushCard } from "@/components/push-card";

export default function NotificationsPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "ORG_ADMIN" ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">Мэдэгдэл</h1>
            <PushCard />
            <Inbox />
          </>
        ) : (
          <p className="text-slate-700">Мэдэгдлийг зөвхөн Байгууллагын админ хүлээн авна.</p>
        )
      }
    </AppShell>
  );
}
