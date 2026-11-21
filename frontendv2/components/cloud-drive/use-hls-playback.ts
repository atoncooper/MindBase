"use client";

/**
 * HLS packaging/playback state for the cloud-drive viewer.
 *
 * The backend packages videos asynchronously. While a file is queued or being
 * packaged we poll GET /cloud/video/:uuid/hls with bounded backoff and expose
 * the state to the viewer; once ready, the same descriptor drives the player.
 * A failed package can be retried manually, and the user can always opt into
 * the original MP4 stream instead of waiting.
 */
import { useCallback, useEffect, useState } from "react";
import { cloudApi, type CloudHlsResponse } from "@/lib/api/cloud";

export interface HlsPlaybackState {
    /** Descriptor to render; null when the user chose the original MP4. */
    info: CloudHlsResponse | null;
    /** Latest descriptor regardless of the raw-video override. */
    latest: CloudHlsResponse | null;
    retrying: boolean;
    error: string | null;
    retry: () => Promise<void>;
    /** Stop polling and play the original MP4 instead. */
    playRaw: () => void;
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

    // Poll only while packaging is in flight. Back off up to 15s; terminal
    // states (ready/failed/unsupported/disabled) stop the loop.
    useEffect(() => {
        if (!enabled || forceRaw || !latest) return;
        const status = latest.status;
        if (status !== "queued" && status !== "processing") return;
        let cancelled = false;
        let timer: number | undefined;
        let attempt = 0;
        const poll = async () => {
            try {
                const next = await cloudApi.getHls(uuid);
                if (cancelled) return;
                setLatest(next);
                if (next.ready) return;
                if (next.status !== "queued" && next.status !== "processing") return;
                attempt += 1;
                timer = window.setTimeout(poll, Math.min(15_000, 4_000 + attempt * 1_000));
            } catch {
                timer = window.setTimeout(poll, 10_000);
            }
        };
        timer = window.setTimeout(poll, 4_000);
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
