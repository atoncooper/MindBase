"use client";

import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div className="cd-overlay" onClick={onCancel}>
      <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="cd-title">{title}</h3>
        <p className="cd-message">{message}</p>
        <div className="cd-actions">
          <button className="cd-btn cd-btn-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`cd-btn cd-btn-confirm ${variant === "danger" ? "cd-btn-danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      <style jsx>{`
        .cd-overlay {
          position: fixed; inset: 0; z-index: 10000;
          display: flex; align-items: center; justify-content: center;
          background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px);
          animation: cdFadeIn .12s ease;
        }
        @keyframes cdFadeIn { from { opacity: 0; } to { opacity: 1; } }

        .cd-modal {
          width: 400px; max-width: 90vw; padding: 24px; border-radius: 18px;
          background: linear-gradient(180deg, var(--card) 0%, var(--paper-3) 100%);
          border: 1px solid var(--border);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.2);
          animation: cdSlideUp .18s ease;
        }
        @keyframes cdSlideUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .cd-title { font-size: 16px; font-weight: 700; margin: 0 0 8px; color: var(--foreground); letter-spacing: -0.02em; }
        .cd-message { font-size: 13.5px; color: var(--muted-foreground); margin: 0 0 22px; line-height: 1.6; }
        .cd-actions { display: flex; gap: 10px; justify-content: flex-end; }

        .cd-btn {
          min-width: 80px; min-height: 38px; padding: 8px 18px; border-radius: 10px;
          font-size: 13px; font-weight: 650; cursor: pointer; border: none;
          transition: opacity .12s, background .12s, transform .1s;
        }
        .cd-btn:active { transform: scale(0.97); }

        .cd-btn-cancel {
          background: var(--paper-3); color: var(--muted-foreground); border: 1px solid var(--border);
        }
        .cd-btn-cancel:hover { background: var(--muted); color: var(--foreground); }

        .cd-btn-confirm {
          background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, transparent) 0%, color-mix(in srgb, var(--accent) 8%, transparent) 100%);
          color: var(--accent-strong);
          border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
        }
        .cd-btn-confirm:hover {
          background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, transparent) 0%, color-mix(in srgb, var(--accent) 12%, transparent) 100%);
        }

        .cd-btn-danger {
          background: linear-gradient(180deg, rgba(248, 113, 113, 0.18) 0%, rgba(248, 113, 113, 0.08) 100%);
          color: #f87171;
          border: 1px solid rgba(248, 113, 113, 0.25);
        }
        .cd-btn-danger:hover {
          background: linear-gradient(180deg, rgba(248, 113, 113, 0.24) 0%, rgba(248, 113, 113, 0.14) 100%);
        }
      `}</style>
    </div>,
    document.body
  );
}
