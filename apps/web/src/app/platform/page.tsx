"use client";

import { PlatformShell } from "@/components/platform/platform-shell";
import { TenantsScreen } from "@/components/platform/tenants-screen";

export default function PlatformPage() {
  return <PlatformShell>{() => <TenantsScreen />}</PlatformShell>;
}
