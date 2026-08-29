/**
 * Minimal global toast/notification system, with optional expandable detail.
 *
 * `ToastProvider` is mounted once at the app root; any descendant calls
 * `useToast()` to push a transient banner into the top-right viewport.
 * Colors follow the strict monochrome design system — only the two semantic
 * tokens (`--ok` / `--danger`) are used, matching the status palette.
 *
 * A toast may carry `details` (e.g. the full failure log). When present a
 * 「详情」button appears; clicking it opens a modal dialog with the complete,
 * selectable/copyable error text.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.warning("成功 2 / 失败 1", { title: "部分分P 入库失败", details: "P1 音频超时；P2 空正文" });
 *   toast.error("reason", { title: "入库失败", details: stack });
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "success" | "warning" | "error";

export interface ToastOptions {
  title?: string;
  /** Full error text shown in the detail dialog; enables the 「详情」 button. */
  details?: string;
  /** Auto-dismiss delay in ms; overrides the per-kind default. */
  duration?: number;
}

export interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  /** Push a raw toast; kind drives styling + default duration. */
  toast: (toast: { kind: ToastKind; message: string } & ToastOptions) => void;
  success: (message: string, options?: ToastOptions) => void;
  warning: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

/** Default dwell per kind — failures linger longer so they can be read. */
function defaultDuration(kind: ToastKind): number {
  return kind === "error" || kind === "warning" ? 9000 : 3500;
}

/** Raw detail payload captured when 「详情」 is clicked. */
interface DetailState {
  title: string;
  details: string;
  kind: ToastKind;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: { kind: ToastKind; message: string } & ToastOptions) => {
      const id = nextId++;
      const { kind, message, ...rest } = input;
      setToasts((prev) => [...prev.slice(-4), { id, kind, message, ...rest }]);
      const duration = rest.duration ?? defaultDuration(kind);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (message, options) => push({ kind: "success", message, ...options }),
      warning: (message, options) => push({ kind: "warning", message, ...options }),
      error: (message, options) => push({ kind: "error", message, ...options }),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => {
          const hasDetails = t.details !== undefined && t.details !== "";
          return (
            <div
              key={t.id}
              className={`toast toast--${t.kind}`}
              role={t.kind === "error" || t.kind === "warning" ? "alert" : "status"}
            >
              <div className="toast__body">
                {t.title !== undefined && t.title !== "" && (
                  <div className="toast__title">{t.title}</div>
                )}
                <div className="toast__message">{t.message}</div>
                {hasDetails && (
                  <button
                    type="button"
                    className="toast__details"
                    onClick={() =>
                      setDetail({
                        title: t.title ?? "错误详情",
                        details: t.details ?? "",
                        kind: t.kind,
                      })
                    }
                  >
                    详情
                  </button>
                )}
              </div>
              <button
                type="button"
                className="toast__close"
                aria-label="关闭"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {detail !== null &&
        createPortal(
          <div
            className="modal-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDetail(null);
            }}
          >
            <div className="modal toast-detail" role="dialog" aria-modal="true">
              <div className="modal__head">
                <h3 className="modal__title">{detail.title}</h3>
                <button
                  type="button"
                  className="toast__close"
                  aria-label="关闭"
                  onClick={() => setDetail(null)}
                >
                  ×
                </button>
              </div>
              <pre className="toast-detail__body">{detail.details}</pre>
              <div className="toast-detail__foot">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => setDetail(null)}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/** Access the toast API; must be called from inside <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}
