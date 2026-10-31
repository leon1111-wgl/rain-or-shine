// Accessible modal: focus moves into the dialog, Tab stays inside, Escape or the backdrop closes it, and focus
// returns to the element that opened it.

import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n";

export function Dialog({ title, onClose, children, actions, testId }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; testId?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input, select, textarea")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={ref} data-testid={testId}>
        <h2 id="dialog-title">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t("dialog.close")}
          </button>
          {actions}
        </div>
      </section>
    </div>
  );
}
