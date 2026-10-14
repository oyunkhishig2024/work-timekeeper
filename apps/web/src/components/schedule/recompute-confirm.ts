import { ApiRequestError } from "@/lib/api";

/** A change that reaches today or the past rewrites recorded attendance: the API asks for a confirmation first. */
export const needsConfirm = (e: unknown): boolean =>
  e instanceof ApiRequestError && e.code === "RECOMPUTE_CONFIRMATION_REQUIRED";

export const RECOMPUTE_TEXT =
  "Энэ өдөр өнөөдөр эсвэл өнгөрсөн тул бүртгэгдсэн ирц өөрчлөгдөнө. Үргэлжлүүлэх үү?";
