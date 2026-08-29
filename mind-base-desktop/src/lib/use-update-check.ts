/**
 * Shared state machine for update checks.
 *
 * Policy: automatic (startup) checks are silent — failures only reach the
 * console, and "no update" produces no UI. Manual checks may surface errors
 * inline; consumers branch on `lastSource`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getConfig } from "./config";
import { checkUpdate, toErrorMessage } from "./updater";
import type { UpdateInfo } from "./updater";

/** How a finished check was triggered. */
export type UpdateCheckSource = "auto" | "manual";

export interface UpdateCheckState {
  /** Detected update; null when none found or nothing checked yet. */
  update: UpdateInfo | null;
  /** Error message of the last finished check; null on success. */
  error: string | null;
  /** True while a network check is in flight. */
  checking: boolean;
  /** How the last finished check was triggered; null before any check. */
  lastSource: UpdateCheckSource | null;
  /** Run a check now. `source` controls how callers surface the outcome. */
  check: (source: UpdateCheckSource) => Promise<void>;
  /** Hide the current update until a later check finds one again. */
  dismiss: () => void;
}

/**
 * Update-check state with one delayed automatic check on mount.
 *
 * The auto check runs after `autoCheckDelayMs` but only when the persisted
 * config has `autoCheckUpdates` enabled.
 */
export function useUpdateCheck(autoCheckDelayMs: number): UpdateCheckState {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [lastSource, setLastSource] = useState<UpdateCheckSource | null>(null);
  const disposedRef = useRef<boolean>(false);

  const check = useCallback(async (source: UpdateCheckSource): Promise<void> => {
    setChecking(true);
    try {
      const info = await checkUpdate();
      if (disposedRef.current) return;
      setError(null);
      setLastSource(source);
      // No-update results never occupy the banner.
      setUpdate(info.hasUpdate ? info : null);
    } catch (err) {
      if (disposedRef.current) return;
      setLastSource(source);
      setError(toErrorMessage(err));
      if (source === "auto") console.warn("[update] auto check failed", err);
    } finally {
      if (!disposedRef.current) setChecking(false);
    }
  }, []);

  const dismiss = useCallback((): void => {
    // Dismissing also resets inline feedback so a dismissed manual check does
    // not later render as "已是最新版本".
    setUpdate(null);
    setLastSource(null);
    setError(null);
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const config = await getConfig();
          if (!config.autoCheckUpdates || disposedRef.current) return;
          await check("auto");
        } catch (err) {
          // Config read failure must stay invisible too (offline-first).
          console.warn("[update] auto check skipped", err);
        }
      })();
    }, autoCheckDelayMs);

    return () => {
      disposedRef.current = true;
      window.clearTimeout(timer);
    };
  }, [autoCheckDelayMs, check]);

  return { update, error, checking, lastSource, check, dismiss };
}
