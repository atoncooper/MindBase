"use client";

/**
 * Passive HLS status chip shown over an already-playing raw video.
 *
 * Packaging is asynchronous and NEVER blocks playback: the viewer starts the
 * original MP4 immediately and this chip only reports background progress.
 * - queued/processing -> "转码中" (informational, no spinner blocking video)
 * - ready             -> offers a switch to the HLS rendition
 * - failed            -> offers a retry, without degrading raw playback
 * There is deliberately no full-screen packaging card anymore.
 */
import { AlertCircle, Loader2, RotateCcw, Sparkles } from "lucide-react";

interface Props {
    /** Backend packaging status ("queued" | "processing" | "failed" | ...). */
    status?: string;
    progress?: number;
    /** A ready descriptor exists, so a switch to HLS is possible. */
    ready: boolean;
    retrying: boolean;
    /** Last manual retry error, if any. */
    error?: string | null;
    onRetry: () => void;
    onSwitchToHls: () => void;
}

const chipClass =
    "pointer-events-auto inline-flex max-w-[min(92vw,26rem)] items-center gap-1.5 rounded-full " +
    "bg-black/55 px-3 py-1.5 text-[12px] font-medium text-white/90 backdrop-blur-sm";

export function HlsStatusChip({ status, progress, ready, retrying, error, onRetry, onSwitchToHls }: Props) {
    if (ready) {
        return (
            <button type="button" onClick={onSwitchToHls} className={chipClass} title="切换到高清版本">
                <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                高清版已就绪，切换
            </button>
        );
    }
    if (status === "queued" || status === "processing") {
        const pct = typeof progress === "number" && progress > 0 ? ` ${Math.min(99, progress)}%` : "";
        return (
            <span className={chipClass} role="status" aria-live="polite">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                高清版转码中{pct} · 可直接观看原画
            </span>
        );
    }
    if (status === "failed") {
        return (
            <span className={chipClass} role="status">
                <AlertCircle className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
                {error || "高清版转码失败"}
                <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className="pointer-events-auto ml-1 inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] disabled:opacity-60"
                >
                    {retrying ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    )}
                    {retrying ? "重试中" : "重试"}
                </button>
            </span>
        );
    }
    // ready/failed/queued/processing covered; disabled/unsupported/not_started/
    // unknown need no chrome at all (the raw video plays normally).
    return null;
}
