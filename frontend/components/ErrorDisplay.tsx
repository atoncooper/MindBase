"use client";

import { useState, useEffect, useCallback } from "react";
import { X, AlertTriangle, AlertCircle, Info } from "lucide-react";
import { sanitizeError } from "@/lib/error-utils";

type Variant = "toast" | "inline" | "banner";
type Severity = "error" | "warning" | "info";

interface ErrorDisplayProps {
  /** Raw error value — will be sanitised before display */
  error: unknown;
  /** Display variant */
  variant?: Variant;
  /** Severity (default: "error") */
  severity?: Severity;
  /** Called when the user dismisses */
  onDismiss?: () => void;
  /** Auto-dismiss timeout in ms (toast only; default 4000) */
  autoDismiss?: number;
  /** Extra CSS class */
  className?: string;
}

const SEVERITY_ICONS: Record<Severity, typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const SEVERITY_STYLES: Record<Severity, string> = {
  error: "err-display--error",
  warning: "err-display--warning",
  info: "err-display--info",
};

export default function ErrorDisplay({
  error,
  variant = "inline",
  severity = "error",
  onDismiss,
  autoDismiss = 4000,
  className = "",
}: ErrorDisplayProps) {
  const [visible, setVisible] = useState(true);
  const message = sanitizeError(error);
  const Icon = SEVERITY_ICONS[severity];

  const dismiss = useCallback(() => {
    setVisible(false);
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    if (variant === "toast" && autoDismiss > 0) {
      const timer = setTimeout(dismiss, autoDismiss);
      return () => clearTimeout(timer);
    }
  }, [variant, autoDismiss, dismiss]);

  // Reset visibility when error changes
  useEffect(() => {
    setVisible(true);
  }, [error]);

  if (!visible || !message) return null;

  return (
    <div
      className={`err-display err-display--${variant} ${SEVERITY_STYLES[severity]} ${className}`}
      role="alert"
    >
      <Icon size={variant === "toast" ? 14 : 16} className="err-display-icon" />
      <span className="err-display-text">{message}</span>
      <button
        className="err-display-dismiss"
        onClick={dismiss}
        aria-label="关闭"
        type="button"
      >
        <X size={variant === "toast" ? 12 : 14} />
      </button>
    </div>
  );
}

/**
 * Convenience hook for managing a single ErrorDisplay state.
 *
 * Usage:
 *   const { error, setError, clearError } = useErrorDisplay();
 *   // ...
 *   {error && <ErrorDisplay error={error} variant="inline" onDismiss={clearError} />}
 */
export function useErrorDisplay() {
  const [error, setError] = useState<unknown>(null);

  const set = useCallback((err: unknown) => setError(err), []);
  const clear = useCallback(() => setError(null), []);

  return { error, setError: set, clearError: clear };
}
