"use client";

/**
 * Custom video chrome for cloud-drive playback (MP4 + HLS).
 *
 * Native controls look out of place in the app and cannot be themed; this
 * renders a thin Apple-like control bar with play/pause, seek, time, mute +
 * volume, playback rate and fullscreen. It auto-hides while playing and
 * re-appears on pointer movement. The owning players keep all URL-refresh and
 * error logic; this component only talks to the <video> element.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
    Maximize,
    Minimize,
    Pause,
    Play,
    Settings2,
    Volume2,
    VolumeX,
} from "lucide-react";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function VideoControls({
    videoRef,
    containerRef,
    disabled = false,
}: {
    videoRef: RefObject<HTMLVideoElement | null>;
    containerRef: RefObject<HTMLDivElement | null>;
    disabled?: boolean;
}) {
    const [playing, setPlaying] = useState(false);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [rate, setRate] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [rateOpen, setRateOpen] = useState(false);
    const [visible, setVisible] = useState(true);
    const hideTimer = useRef<number | null>(null);

    const showControls = useCallback(() => {
        setVisible(true);
        if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        const video = videoRef.current;
        if (!video || video.paused) return;
        hideTimer.current = window.setTimeout(() => setVisible(false), 2600);
    }, [videoRef]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const onTime = () => setCurrent(video.currentTime || 0);
        const onMeta = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
        const onPlay = () => {
            setPlaying(true);
            showControls();
        };
        const onPause = () => {
            setPlaying(false);
            setVisible(true);
            if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        };
        const onVolume = () => {
            setVolume(video.volume);
            setMuted(video.muted);
        };
        const onRate = () => setRate(video.playbackRate || 1);
        const onFs = () => setFullscreen(document.fullscreenElement === containerRef.current);
        video.addEventListener("timeupdate", onTime);
        video.addEventListener("progress", onTime);
        video.addEventListener("loadedmetadata", onMeta);
        video.addEventListener("durationchange", onMeta);
        video.addEventListener("play", onPlay);
        video.addEventListener("pause", onPause);
        video.addEventListener("volumechange", onVolume);
        video.addEventListener("ratechange", onRate);
        document.addEventListener("fullscreenchange", onFs);
        onVolume();
        onRate();
        onMeta();
        return () => {
            video.removeEventListener("timeupdate", onTime);
            video.removeEventListener("progress", onTime);
            video.removeEventListener("loadedmetadata", onMeta);
            video.removeEventListener("durationchange", onMeta);
            video.removeEventListener("play", onPlay);
            video.removeEventListener("pause", onPause);
            video.removeEventListener("volumechange", onVolume);
            video.removeEventListener("ratechange", onRate);
            document.removeEventListener("fullscreenchange", onFs);
            if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        };
    }, [videoRef, containerRef, showControls]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const onMove = () => showControls();
        const onLeave = () => {
            const video = videoRef.current;
            if (video && !video.paused) setVisible(false);
        };
        container.addEventListener("mousemove", onMove);
        container.addEventListener("touchstart", onMove, { passive: true });
        container.addEventListener("mouseleave", onLeave);
        return () => {
            container.removeEventListener("mousemove", onMove);
            container.removeEventListener("touchstart", onMove);
            container.removeEventListener("mouseleave", onLeave);
        };
    }, [containerRef, videoRef, showControls]);

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
    }, [videoRef]);

    const toggleMute = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
    }, [videoRef]);

    const toggleFullscreen = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        else void container.requestFullscreen?.().catch(() => undefined);
    }, [containerRef]);

    const seek = (value: number) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(video.duration)) return;
        video.currentTime = Math.min(Math.max(0, value), video.duration);
        setCurrent(video.currentTime);
    };

    const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

    if (disabled) return null;

    return (
        <>
            {/* Center play affordance while paused */}
            {!playing && (
                <button
                    type="button"
                    onClick={togglePlay}
                    aria-label="播放"
                    className="absolute inset-0 z-[5] grid place-items-center bg-black/10 transition-colors hover:bg-black/15"
                >
                    <span className="grid h-16 w-16 place-items-center rounded-full bg-white/15 text-white shadow-lg backdrop-blur-md ring-1 ring-white/20 transition-transform hover:scale-105">
                        <Play className="ml-1 h-7 w-7 fill-current" aria-hidden="true" />
                    </span>
                </button>
            )}

            <div
                className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-10 transition-opacity duration-200 ${
                    visible || !playing ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
            >
                <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={current}
                    onChange={(event) => seek(Number(event.target.value))}
                    aria-label="播放进度"
                    className="video-seek w-full"
                    style={{ ["--progress" as string]: `${progress}%` }}
                />

                <div className="mt-1 flex items-center gap-2 text-white">
                    <button
                        type="button"
                        onClick={togglePlay}
                        aria-label={playing ? "暂停" : "播放"}
                        className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-white/15"
                    >
                        {playing ? (
                            <Pause className="h-4 w-4 fill-current" aria-hidden="true" />
                        ) : (
                            <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden="true" />
                        )}
                    </button>

                    <span className="text-[11px] tabular-nums text-white/85">
                        {formatTime(current)} / {formatTime(duration)}
                    </span>

                    <div className="ml-auto flex items-center gap-0.5">
                        <div className="group/vol flex items-center">
                            <button
                                type="button"
                                onClick={toggleMute}
                                aria-label={muted ? "取消静音" : "静音"}
                                className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-white/15"
                            >
                                {muted || volume === 0 ? (
                                    <VolumeX className="h-4 w-4" aria-hidden="true" />
                                ) : (
                                    <Volume2 className="h-4 w-4" aria-hidden="true" />
                                )}
                            </button>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={muted ? 0 : volume}
                                onChange={(event) => {
                                    const video = videoRef.current;
                                    if (!video) return;
                                    video.muted = false;
                                    video.volume = Number(event.target.value);
                                }}
                                aria-label="音量"
                                className="video-volume h-1 w-0 cursor-pointer opacity-0 transition-all duration-200 group-hover/vol:w-16 group-hover/vol:opacity-100"
                            />
                        </div>

                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setRateOpen((open) => !open)}
                                aria-label="播放速度"
                                className="flex h-8 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-white/90 transition-colors hover:bg-white/15"
                            >
                                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                                {rate}×
                            </button>
                            {rateOpen && (
                                <div className="absolute bottom-full right-0 mb-2 w-20 overflow-hidden rounded-xl bg-black/90 py-1 text-[12px] text-white shadow-xl ring-1 ring-white/15 backdrop-blur">
                                    {RATES.map((value) => (
                                        <button
                                            key={value}
                                            type="button"
                                            onClick={() => {
                                                const video = videoRef.current;
                                                if (video) video.playbackRate = value;
                                                setRateOpen(false);
                                            }}
                                            className={`flex w-full items-center justify-between px-3 py-1.5 hover:bg-white/10 ${
                                                value === rate ? "text-white" : "text-white/75"
                                            }`}
                                        >
                                            {value}×
                                            {value === rate && <span aria-hidden="true">✓</span>}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            aria-label={fullscreen ? "退出全屏" : "全屏"}
                            className="grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-white/15"
                        >
                            {fullscreen ? (
                                <Minimize className="h-4 w-4" aria-hidden="true" />
                            ) : (
                                <Maximize className="h-4 w-4" aria-hidden="true" />
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
