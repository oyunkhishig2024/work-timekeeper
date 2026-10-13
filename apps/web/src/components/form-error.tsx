"use client";

import { useEffect, useRef } from "react";

/**
 * A form or page error. It announces itself to screen readers (role="alert") and scrolls into view, so that on a phone the
 * person sees it even when the form is taller than the screen. A field's own error uses `id` with the field's `aria-describedby`.
 */
export function FormError({
  message,
  id,
  className = "text-sm text-red-700",
}: {
  message: string | null | undefined;
  id?: string;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [message]);
  if (!message) return null;
  return (
    <p ref={ref} id={id} role="alert" className={className}>
      {message}
    </p>
  );
}
