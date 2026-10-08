"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** A modal dialog on the platform's `<dialog>`: focus stays inside, Esc closes it, the page behind is inert. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-slate-300 p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="p-5">
        <h2 id="modal-title" className="text-lg font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}

export const fieldClass =
  "mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-3 text-base";
export const primaryButton =
  "min-h-11 rounded-md bg-teal-700 px-4 font-semibold text-white hover:bg-teal-800 disabled:opacity-60";
export const secondaryButton =
  "min-h-11 rounded-md border border-slate-300 bg-white px-4 font-medium hover:bg-slate-100 disabled:opacity-60";
