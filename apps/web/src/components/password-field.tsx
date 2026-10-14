"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { fieldClass } from "./styles";

/**
 * A password field with an eye button that shows or hides what was typed (so a long password can be checked before sending).
 * The label sits above the field; the button is outside the label so the label belongs to the input only.
 */
export function PasswordField({
  label,
  ...input
}: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "id">) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          {...input}
          id={id}
          type={shown ? "text" : "password"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${fieldClass} pr-12`}
        />
        <button
          type="button"
          aria-label={shown ? "Нууц үгийг нуух" : "Нууц үгийг харуулах"}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-0 mt-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-600 hover:text-slate-900"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {shown ? (
              <>
                <path d="M3 3l18 18" />
                <path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9" />
                <path d="M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.4-1" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </>
            ) : (
              <>
                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
