import { ApiRequestError } from "@/lib/api";

/** The text shown when loading a screen's data failed. */
export const loadErrorText = (e: unknown): string =>
  e instanceof ApiRequestError ? e.message : "Мэдээллийг уншиж чадсангүй. Дахин оролдоно уу.";

/** The text shown when saving or changing something failed. */
export const actionErrorText = (e: unknown): string =>
  e instanceof ApiRequestError ? e.message : "Алдаа гарлаа. Дахин оролдоно уу.";
