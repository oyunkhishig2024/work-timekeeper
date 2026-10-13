import { useEffect } from "react";

/** The browser tab title of a page: «<page> · Timekeeper Work». Every page names itself so tabs and screen readers can tell them apart. */
export function usePageTitle(page: string | undefined): void {
  useEffect(() => {
    document.title = page ? `${page} · Timekeeper Work` : "Timekeeper Work";
  }, [page]);
}
