"use client";

/**
 * Status panels shown while the cloud-drive video is being packaged to HLS.
 *
 * HLS packaging is asynchronous (ffmpeg on app-cloud): the file viewer polls
 * GET /cloud/video/:uuid/hls and swaps in the HLS player as soon as it is
 * ready. Until then we show the real state instead of silently falling back to
 * the heavy MP4 stream; a failed package offers a manual retry.
 */
import { AlertCircle, Loader2, Play, RotateCcw } from "lucide-react";

interface PackagingProps {
    progress?: number;
    attempts?: number;
    onPlayRaw: () => void;
}

export function HlsPackagingCard({ progress, attempts, onPlayRaw }: PackagingProps) {
    const pct = typeof progress === "number" ? Math.min(100, Math.max(0, progress)) : 0;
    return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-border-subtle bg-surface/60 px-6 py-16 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Loader2 className="h-6 w-6 animate-spin" />
            </span>
            <div>
                <p className="text-[15px] font-medium text-foreground">视频正在转码</p>
                <p className="mt-1 text-[13px] text-secondary">
                    完成后会自动开始播放（通常 1–3 分钟，长视频更久）
                    {attempts !== undefined && attempts > 1 ? ` · 第 ${attempts} 次尝试` : ""}
                </p>
            </div>
            {pct > 0 && (
                <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-border-subtle">
                    <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${pct}%` }}
                    />
                </div>
            )}
            <button
                type="button"
                onClick={onPlayRaw}
                className="btn-pill btn-ghost inline-flex h-9 items-center gap-1.5 px-5 text-[13px]"
            >
                <Play className="h-4 w-4" />
                直接播放原视频
            </button>
        </div>
    );
}

interface FailureProps {
    message?: string | null;
    attempts?: number;
    retryable?: boolean;
    retrying: boolean;
    onRetry: () => void;
    onPlayRaw: () => void;
}

export function HlsFailureCard({
    message,
    attempts,
    retryable = true,
    retrying,
    onRetry,
    onPlayRaw,
}: FailureProps) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border-subtle bg-surface/60 px-6 py-16 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/5 text-danger">
                <AlertCircle className="h-6 w-6" />
            </span>
            <div>
                <p className="text-[15px] font-medium text-foreground">视频转码失败</p>
                <p className="mt-1 max-w-md break-words text-[13px] text-secondary">
                    {message || "转码服务暂时不可用，可以重试或直接播放原视频。"}
                    {attempts !== undefined && attempts > 1 ? `（已尝试 ${attempts} 次）` : ""}
                </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
                {retryable && (
                    <button
                        type="button"
                        onClick={onRetry}
                        disabled={retrying}
                        className="btn-pill inline-flex h-9 items-center gap-1.5 px-5 text-[13px] disabled:opacity-60"
                    >
                        {retrying ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <RotateCcw className="h-4 w-4" />
                        )}
                        {retrying ? "正在重试…" : "重试转码"}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onPlayRaw}
                    className="btn-pill btn-ghost inline-flex h-9 items-center gap-1.5 px-5 text-[13px]"
                >
                    <Play className="h-4 w-4" />
                    播放原视频
                </button>
            </div>
        </div>
    );
}
