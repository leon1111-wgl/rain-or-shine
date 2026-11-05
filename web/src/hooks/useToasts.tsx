import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "ok" | "bad";

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastApi {
  show(text: string, tone?: ToastTone): void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DEFAULT_MS = 3_500;

export function ToastProvider({ children, durationMs = DEFAULT_MS }: { children: ReactNode; durationMs?: number }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback(
    (text: string, tone: ToastTone = "info") => {
      const id = next.current++;
      setToasts((list) => [...list.slice(-3), { id, text, tone }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), durationMs);
    },
    [durationMs],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} role="status" data-testid="toast">
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const silent: ToastApi = { show: () => undefined };

export function useToasts(): ToastApi {
  return useContext(ToastContext) ?? silent;
}
