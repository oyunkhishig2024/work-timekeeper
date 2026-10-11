"use client";

import { AppShell } from "@/components/app-shell";
import { LocationsScreen } from "@/components/locations/locations-screen";

export default function LocationsPage() {
  return (
    <AppShell>
      {(user) =>
        user.role === "ORG_ADMIN" ? (
          <LocationsScreen />
        ) : (
          <p className="text-slate-700">Байршлыг зөвхөн Байгууллагын админ тохируулна.</p>
        )
      }
    </AppShell>
  );
}
