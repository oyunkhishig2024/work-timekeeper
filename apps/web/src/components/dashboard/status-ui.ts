import type { Status } from "@/lib/attendance";

/** Colours of the statuses; text on the badge backgrounds keeps a contrast of at least 4.5:1. */
export const STATUS_STYLE: Record<Status, { bar: string; badge: string; text: string }> = {
  ON_TIME: { bar: "bg-green-600", badge: "bg-green-100 text-green-900", text: "text-green-800" },
  LATE: { bar: "bg-amber-500", badge: "bg-amber-100 text-amber-900", text: "text-amber-800" },
  EXCUSED: { bar: "bg-blue-500", badge: "bg-blue-100 text-blue-900", text: "text-blue-800" },
  NO_SHOW: { bar: "bg-red-600", badge: "bg-red-100 text-red-900", text: "text-red-800" },
  PENDING: { bar: "bg-slate-300", badge: "bg-slate-100 text-slate-800", text: "text-slate-700" },
};
