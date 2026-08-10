"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Info, Loader2 } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared Apple iOS-alert-style confirmation dialog. Portaled to document.body
 * so it escapes any overflow-hidden ancestor. Escape and backdrop click cancel
 * (unless busy). Destructive actions render a red icon badge + red confirm
 * text, mirroring UIAlertController. Used by chat (session delete) and notes
 * (note delete).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape to cancel (disabled while an async confirm is in flight).
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={busy ? undefined : onCancel} />

          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
            className="relative w-full max-w-[320px] overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]"
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
          >
            {/* Body: icon badge + centered title/message */}
            <div className="px-6 pb-5 pt-6 text-center">
              <div
                className={`mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full ${
                  danger ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"
                }`}
              >
                {danger ? (
                  <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Info className="h-5 w-5" aria-hidden="true" />
                )}
              </div>
              <h2 className="text-[16px] font-semibold tracking-tight text-foreground">{title}</h2>
              {message && (
                <p className="mt-1.5 text-[13px] leading-relaxed text-secondary">{message}</p>
              )}
            </div>

            {/* Buttons: iOS-style split row with hairline divider. Destructive
                confirm renders in red text, normal in accent. */}
            <div className="flex border-t border-border-subtle">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="flex-1 h-11 text-[14px] font-medium text-secondary transition-colors hover:bg-foreground/[0.04] disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className={`flex flex-1 items-center justify-center gap-1.5 h-11 border-l border-border-subtle text-[14px] font-semibold transition-colors hover:bg-foreground/[0.04] disabled:opacity-50 disabled:hover:bg-transparent ${
                  danger ? "text-danger" : "text-accent"
                }`}
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
