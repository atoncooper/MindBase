"use client";

/**
 * HLS packaging/playback state for the cloud-drive viewer.
 *
 * HLS is a progressive enhancement, never a precondition for playback: the
 * viewer starts the original MP4 immediately and this hook polls
 * GET /cloud/video/:uuid/hls (which lazily enqueues packaging server-side while
 * the video is watched) in the background. When a ready descriptor arrives the
 * viewer may switch to HLS; queued/processing only drive a passive chip.
 *
 * The backend never reports "processing" for a video that was never enqueued:
 * such a read is answered with "queued" (lazy enqueue) or "not_started", so a
 * stuck spinner can no longer happen.
 */
import { useCallback, useEffect, useState } from "react";
import { cloudApi, type CloudHlsResponse } from "@/lib/api/cloud";

export interface HlsPlaybackState {
    /** Descriptor to render; null when the viewer is on the raw MP4. */
    info: CloudHlsResponse | null;
    /** Latest descriptor regardless of the raw fallback override. */
    latest: CloudHlsResponse | null;
    retrying: boolean;
    error: string | null;
    retry: () => Promise<void>;
    /** HLS playback failed: stay on the original MP4 from now on. */
    playRaw: () => void;
}

/** Non-terminal packaging states the viewer keeps polling for. */
function isPending(status: string | undefined): boolean {
    return status === "queued" || status === "processing";
}

export function useHlsPlayback(
    uuid: string,
    enabled: boolean,
    initial: CloudHlsResponse | null,
): HlsPlaybackState {
    const [latest, setLatest] = useState<CloudHlsResponse | null>(initial);
    const [forceRaw, setForceRaw] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);

    // Seed from the initial raw-file fetch (runs once per file).
    useEffect(() => {
        setLatest(initial);
    }, [initial]);

    // Poll only while packaging is pending. Back off up to 15s; terminal
    // states (ready/failed/unsupported/disabled/not_started/unknown) stop.
    // A null descriptor (initial read failed) is retried a few times so a
    // transient error does not hide an HLS upgrade forever.
    useEffect(() => {
        if (!enabled || forceRaw) return;
        if (latest && !isPending(latest.status)) return;
        let cancelled = false;
        let timer: number | undefined;
        let attempt = 0;
        const poll = async () => {
            try {
                const next = await cloudApi.getHls(uuid);
                if (cancelled) return;
                setLatest(next);
                if (next.ready || !isPending(next.status)) return;
                attempt += 1;
                timer = window.setTimeout(poll, Math.min(15_000, 4_000 + attempt * 1_000));
            } catch {
                attempt += 1;
                if (attempt > 5) return;
                timer = window.setTimeout(poll, 10_000);
            }
        };
        timer = window.setTimeout(poll, latest ? 4_000 : 1_000);
        return () => {
            cancelled = true;
            if (timer) window.clearTimeout(timer);
        };
    }, [uuid, enabled, forceRaw, latest, nonce]);

    const retry = useCallback(async () => {
        setRetrying(true);
        setError(null);
        try {
            const next = await cloudApi.retryHls(uuid);
            setLatest(next);
            setNonce((n) => n + 1);
        } catch (e) {
            setError(e instanceof Error ? e.message : "重试失败，请稍后再试");
        } finally {
            setRetrying(false);
        }
    }, [uuid]);

    const playRaw = useCallback(() => setForceRaw(true), []);

    return {
        info: forceRaw ? null : latest,
        latest,
        retrying,
        error,
        retry,
        playRaw,
    };
}
