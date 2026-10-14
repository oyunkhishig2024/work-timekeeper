import { useRef, useState } from "react";

/**
 * The error of a form and the field it is about. `issue(field, message)` marks that field (aria-invalid, described by the
 * message), moves focus to it and shows the message; `failure(message)` is for an error about the whole form (the server
 * refused). Fields are found by their `name` inside the form that carries `formRef`.
 */
export function useFieldIssue(formId: string) {
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const errorId = `${formId}-error`;
  return {
    formRef,
    message,
    errorId,
    issue(name: string, text: string): void {
      setField(name);
      setMessage(text);
      formRef.current?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus();
    },
    failure(text: string): void {
      setField(null);
      setMessage(text);
    },
    clear(): void {
      setField(null);
      setMessage(null);
    },
    /** Spread on the field: `<input name="toDate" {...flag("toDate")} />`. */
    flag(name: string) {
      return field === name ? ({ "aria-invalid": true, "aria-describedby": errorId } as const) : {};
    },
  };
}
