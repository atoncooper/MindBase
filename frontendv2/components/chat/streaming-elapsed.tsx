"use client";

import { useEffect, useState } from "react";

/**
 * Seconds elapsed since `startedAt`, ticked once per second while `active`.
 *
 * - When `startedAt` is known the clock is seeded from it, so a component that
 *   remounts mid-stream (session switch, message list remount) still shows the
 *   real elapsed time instead of restarting at 0.
 * - When it is unknown (unparseable message createdAt) the clock counts from the
 *   moment the hook became active, i.e. from mount for a live turn.
 * - The clock only moves inside the interval callback: no `Date.now()` during
 *   render and no synchronous setState in the effect (React 19 compiler lint).
 */
export function useElapsedSeconds(
  startedAt: number | null | undefined,
  active = true
): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) return;
    const effectStartedAt = Date.now();
    const base =
      startedAt != null && Number.isFinite(startedAt)
        ? Math.max(0, Math.floor((effectStartedAt - startedAt) / 1000))
        : 0;
    const timer = setInterval(() => {
      setSeconds(base + Math.max(0, Math.floor((Date.now() - effectStartedAt) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return seconds;
}

/**
 * Small read-only " · 12s" elapsed label. Renders nothing when the stream start
 * is unknown. Key it by the stream start so each new turn remounts the clock
 * instead of inheriting the previous stream's seconds.
 */
export function StreamElapsed({
  startedAt,
  prefix = " · ",
  className,
}: {
  startedAt?: number | null;
  prefix?: string;
  className?: string;
}) {
  const seconds = useElapsedSeconds(startedAt, startedAt != null);
  if (startedAt == null) return null;
  return (
    <span className={className} aria-hidden="true">
      {prefix}
      {seconds}s
    </span>
  );
}
