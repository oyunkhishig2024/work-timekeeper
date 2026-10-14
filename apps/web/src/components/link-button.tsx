import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Navigation that looks like a button: a real link (opens in a new tab, shows its address, works without a click handler).
 * `disabled` renders plain text marked aria-disabled, because a link cannot be disabled. `current` marks the link of the
 * page, filter or period that is in force (aria-current).
 */
export function LinkButton({
  href,
  className,
  disabled = false,
  current = false,
  label,
  children,
}: {
  href: string;
  className: string;
  disabled?: boolean;
  current?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const classes = `${className} inline-flex items-center justify-center`;
  if (disabled) {
    return (
      <span aria-disabled="true" aria-label={label} className={`${classes} opacity-60`}>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={current ? "true" : undefined}
      className={classes}
    >
      {children}
    </Link>
  );
}
