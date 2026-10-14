/** The class names shared by every screen: one place for field, button and chip looks (min height 44 px for touch). */
export const fieldClass =
  "mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-3 text-base";
export const primaryButton =
  "min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";
export const secondaryButton =
  "min-h-11 rounded-md border border-slate-300 bg-white px-4 font-medium hover:bg-slate-100 disabled:opacity-60";
/** Compact secondary button for toolbars and rows. */
export const smallButton =
  "min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-100 disabled:opacity-60";
/** A filter chip; `selected` is the one in force. */
export const chipClass = (selected: boolean): string =>
  `min-h-11 rounded-full border px-4 text-sm ${
    selected
      ? "border-teal-700 bg-teal-700 text-white"
      : "border-slate-300 bg-white hover:bg-slate-100"
  }`;
