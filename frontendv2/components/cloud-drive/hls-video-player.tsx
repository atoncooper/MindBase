"use client";

/**
 * HLS player for cloud-drive videos.
 *
 * Bytes stay on browser -> OpenResty -> MinIO. The HttpOnly hls_token cookie
 * is refreshed from app-cloud before it expires; a fatal network error also
 * triggers one cookie refresh + retry before falling back to the MP4 player.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import type Hls from "hls.js";
import { cloudApi } from "@/lib/api/cloud";
import { VideoControls } from "./video-controls";

interface Props {
    uuid: string;
    playlistUrl: string;
    /** Same-origin poster rendered during packaging (optional). */
    posterUrl?: string;
    expiresIn?: number;
    onFallback: (reason: string) => void;
    /** Fill the parent's full width/height (full-screen cloud-drive viewer). */
    fill?: boolean;
}

type PlayerState = "loading" | "ready" | "error";

export function HlsVideoPlayer({ uuid, playlistUrl, posterUrl, expiresIn = 3600, onFallback, fill = false }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const retriesRef = useRef(0);
    const [state, setState] = useState<PlayerState>("loading");
    const [message, setMessage] = useState("");

    const refreshToken = useCallback(async () => {
        const info = await cloudApi.getHls(uuid);
        if (!info.ready) throw new Error(info.status || "HLS 未就绪");
    }, [uuid]);

    // Refresh the HttpOnly cookie while playback continues. hls.js keeps
    // requesting the same playlist/segment URLs; only the cookie changes.
    useEffect(() => {
        if (expiresIn <= 180) return;
        const delay = Math.max(30_000, (expiresIn - 120) * 1000);
        const timer = window.setTimeout(() => {
            void refreshToken().catch(() => {
                /* the fatal-error path will retry explicitly */
            });
        }, delay);
        return () => window.clearTimeout(timer);
    }, [refreshToken, expiresIn]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        let cancelled = false;
        let hls: Hls | null = null;

        const setup = async () => {
            // Safari supports HLS natively; use the media element directly.
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
                video.src = playlistUrl;
                return;
            }

            const mod = await import("hls.js");
            const HlsCtor = mod.default;
            if (cancelled) return;
            if (!HlsCtor.isSupported()) {
                onFallback("browser_hls_unsupported");
                return;
            }

            hls = new HlsCtor({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 30,
                xhrSetup: (xhr) => {
                    xhr.withCredentials = true;
                },
            });
            hlsRef.current = hls;
            hls.attachMedia(video);
            hls.on(HlsCtor.Events.MEDIA_ATTACHED, () => {
                hls?.loadSource(playlistUrl);
            });
            hls.on(HlsCtor.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                if (retriesRef.current >= 2) {
                    setMessage("HLS 播放失败，已回退到原视频");
                    setState("error");
                    onFallback("hls_fatal");
                    return;
                }
                // Token expiry / transient edge error: refresh cookie once and
                // ask hls.js to retry the current request without rebuilding
                // the player or losing currentTime.
                retriesRef.current += 1;
                setState("loading");
                void refreshToken()
                    .then(() => {
                        hls?.startLoad();
                    })
                    .catch(() => {
                        setState("error");
                        onFallback("hls_token_refresh_failed");
                    });
            });
        };

        void setup().catch(() => {
            if (!cancelled) {
                setState("error");
                onFallback("hls_init_failed");
            }
        });

        return () => {
            cancelled = true;
            hls?.destroy();
            if (hlsRef.current === hls) hlsRef.current = null;
        };
    }, [onFallback, playlistUrl, refreshToken]);

    const retryNow = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        retriesRef.current = 0;
        setMessage("");
        setState("loading");
        hlsRef.current?.startLoad();
        if (!hlsRef.current) {
            video.load();
        }
    }, []);

    return (
        <div
            ref={containerRef}
            className={`group relative w-full overflow-hidden bg-black ${
                fill
                    ? "h-full"
                    : "mx-auto max-w-full rounded-2xl shadow-[0_20px_60px_-24px_rgba(0,0,0,0.55)] ring-1 ring-black/10"
            }`}
        >
            <video
                ref={videoRef}
                playsInline
                preload="metadata"
                poster={posterUrl}
                className={
                    fill
                        ? "block h-full w-full bg-black object-contain"
                        : "mx-auto block max-h-[75dvh] w-full bg-black object-contain"
                }
                onCanPlay={() => setState("ready")}
                onPlaying={() => setState("ready")}
                onWaiting={() => setState("loading")}
                onError={() => {
                    // Native Safari HLS errors land here.
                    if (!hlsRef.current) onFallback("native_hls_error");
                }}
            />

            <VideoControls
                videoRef={videoRef}
                containerRef={containerRef}
                disabled={state === "error"}
            />

            {state === "loading" && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/20">
                    <Loader2 className="h-6 w-6 animate-spin text-white/80" />
                </div>
            )}

            {state === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center text-white">
                    <AlertCircle className="h-7 w-7 text-red-400" />
                    <p className="text-[13px]">{message || "HLS 播放失败"}</p>
                    <button
                        type="button"
                        onClick={retryNow}
                        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-white/25"
                    >
                        <RotateCcw className="h-4 w-4" />
                        重试
                    </button>
                </div>
            )}
        </div>
    );
}
