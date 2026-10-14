import { ApiRequestError } from "@/lib/api";
import { scheduleError } from "@/lib/schedule";

/** The text shown for a failed working week, holiday or shift request. */
export const message = (e: unknown): string =>
  e instanceof ApiRequestError
    ? scheduleError(e.code, e.message)
    : "Холбогдож чадсангүй. Дахин оролдоно уу.";
