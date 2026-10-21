"use client";

/**
 * Public cloud share reading page (/cloud/s/<token>). No auth, no NavBar —
 * an anonymous visitor lander: file metadata, extraction-code gate, inline
 * preview (image / video / audio / pdf / text / markdown), an explicit
 * "cannot preview" state for everything else, and download. All API calls
 * are anonymous same-origin fetches (cloudApi.getSharedInfo / accessShared).
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { cloudApi, formatBytes, type CloudAttestation } from "@/lib/api/cloud";
import { computeDeviceFingerprint, isAutomationEnv } from "@/lib/device-attest";
import { Markdown } from "@/components/markdown";
import {
    AlertCircle,
    CloudDownload,
    File as FileIcon,
    FileImage,
    FileText,
    FileVideo,
    FileWarning,
    Loader2,
    Lock,
    Music,
    Unlock,
} from "lucide-react";

type SharedInfo = Awaited<ReturnType<typeof cloudApi.getSharedInfo>>;
type SharedAccess = Awaited<ReturnType<typeof cloudApi.accessShared>>;

/** 文本类预览的体积上限：超过则引导下载（避免把大文件整段塞进 DOM）。 */
const TEXT_PREVIEW_CAP = 2 * 1024 * 1024;

function fileIcon(mime: string) {
    if (mime.startsWith("image/")) return FileImage;
    if (mime.startsWith("video/")) return FileVideo;
    if (mime.startsWith("audio/")) return Music;
    if (mime === "application/pdf" || mime.startsWith("text/")) return FileText;
    return FileIcon;
}

/** 是否为可客户端拉取文本渲染的类型（markdown 走富文本渲染，text 走代码视图） */
function isTextualView(mode: string): boolean {
    return mode === "text" || mode === "markdown";
}

type TextPreviewState =
    | { state: "loading"; content: "" }
    | { state: "ready"; content: string }
    | { state: "error"; content: "" };

export default function CloudSharePage() {
    const params = useParams<{ token: string }>();
    const token = typeof params?.token === "string" ? params.token : "";

    const [info, setInfo] = useState<SharedInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [code, setCode] = useState("");
    const [unlocking, setUnlocking] = useState(false);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [access, setAccess] = useState<SharedAccess | null>(null);
    // 设备证明票据（attest 签发，绑定 token + 指纹）
    const [attestation, setAttestation] = useState<CloudAttestation | null>(null);
    // 文本类预览内容（text/markdown 拉取 presigned URL 的正文渲染）
    const [textPreview, setTextPreview] = useState<TextPreviewState | null>(null);

    useEffect(() => {
        if (!token) {
            setError("链接无效");
            setLoading(false);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const data = await cloudApi.getSharedInfo(token);
                if (!cancelled) {
                    setInfo(data);
                    setLoading(false);
                    // 设备证明：自动化环境（headless 默认特征）直接拒绝
                    if (isAutomationEnv()) {
                        setAccessError("检测到自动化环境，无法访问分享内容");
                        return;
                    }
                    if (data.challenge) {
                        const fp = await computeDeviceFingerprint(data.challenge);
                        const a = await cloudApi.attestShared(token, {
                            challenge: data.challenge,
                            fingerprint: fp,
                        });
                        if (!cancelled) setAttestation({ fp, ticket: a.ticket });
                    }
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "分享不存在或已失效");
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token]);

    /** 带 412 自动重证明的 access（票据过期 / 服务重启后挑战失效时自愈） */
    const doAccess = useCallback(
        async (body: { code?: string; download?: boolean }): Promise<SharedAccess> => {
            try {
                return await cloudApi.accessShared(token, body, attestation ?? undefined);
            } catch (e) {
                if (e instanceof Error && e.message.includes("设备证明")) {
                    // 票据/挑战失效：重新拉 info → 重新证明 → 重试一次
                    const info2 = await cloudApi.getSharedInfo(token);
                    if (!info2.challenge) throw e;
                    const fp = await computeDeviceFingerprint(info2.challenge);
                    const a = await cloudApi.attestShared(token, {
                        challenge: info2.challenge,
                        fingerprint: fp,
                    });
                    setAttestation({ fp, ticket: a.ticket });
                    return cloudApi.accessShared(token, body, { fp, ticket: a.ticket });
                }
                throw e;
            }
        },
        [token, attestation],
    );

    const unlock = useCallback(
        async (download = false) => {
            if (!token) return;
            setUnlocking(true);
            setAccessError(null);
            try {
                const data = await doAccess({
                    ...(code.trim() ? { code: code.trim() } : {}),
                    download,
                });
                if (download) {
                    // 触发浏览器下载（presigned URL 可能同源 /minio-proxy 或绝对地址）
                    const a = document.createElement("a");
                    a.href = data.url;
                    a.rel = "noopener";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setUnlocking(false);
                    return;
                }
                setTextPreview(null);
                setAccess(data);
            } catch (e) {
                setAccessError(e instanceof Error ? e.message : "提取失败");
            } finally {
                setUnlocking(false);
            }
        },
        [token, code, doAccess]
    );

    // 文本类预览：access 成功后拉取正文（presigned URL 的 disposition 不影响
    // fetch 读体；超限或拉取失败 → 落到"无法展示"卡片 + 下载按钮）
    useEffect(() => {
        if (!access || !isTextualView(access.viewMode) || access.fileSize > TEXT_PREVIEW_CAP) {
            setTextPreview(null);
            return;
        }
        let cancelled = false;
        setTextPreview({ state: "loading", content: "" });
        void (async () => {
            try {
                const res = await fetch(access.url, { cache: "no-store" });
                if (!res.ok) throw new Error("fetch failed");
                const text = await res.text();
                if (!cancelled) setTextPreview({ state: "ready", content: text });
            } catch {
                if (!cancelled) setTextPreview({ state: "error", content: "" });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [access]);

    if (loading) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background">
                <Loader2 className="h-6 w-6 animate-spin text-tertiary" />
            </div>
        );
    }

    if (error || !info) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-danger/5 text-danger">
                    <AlertCircle className="h-6 w-6" />
                </span>
                <p className="mt-4 text-[15px] font-medium text-foreground">
                    {error ?? "分享不存在"}
                </p>
                <p className="mt-1.5 text-[13px] text-secondary">
                    这条分享链接可能已过期或被撤销。
                </p>
            </div>
        );
    }

    const IconComp = fileIcon(info.mimeType);
    const expired = info.expiresAt ? new Date(info.expiresAt).getTime() < Date.now() : false;

    // 无法在线预览的统一判定（渲染为明确的"无法展示"卡片 + 下载）
    const textual = access ? isTextualView(access.viewMode) : false;
    const textOversize = textual && (access?.fileSize ?? 0) > TEXT_PREVIEW_CAP;
    const textFailed = textual && textPreview?.state === "error";
    const previewUnavailable =
        !!access &&
        (access.viewMode === "unsupported" ||
            access.viewMode === "html" ||
            textOversize ||
            textFailed);

    const unavailableHint = textOversize
        ? "文件过大，无法在线预览"
        : textFailed
          ? "预览加载失败"
          : "该文件类型不支持在线预览";

    return (
        <div className="min-h-screen bg-background">
            <div className="mx-auto max-w-[760px] px-6 py-10 md:py-16">
                {/* 品牌行 */}
                <div className="mb-10 flex items-center gap-2 text-[11px] uppercase tracking-wider text-tertiary">
                    <CloudDownload className="h-3 w-3" />
                    <span>MindBase · 文件分享</span>
                </div>

                {/* 文件卡片 */}
                <div className="rounded-2xl border border-border bg-surface p-6 shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
                    <div className="flex items-start gap-4">
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                            <IconComp className="h-6 w-6" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h1 className="break-all text-[17px] font-semibold leading-snug text-foreground">
                                {info.fileName}
                            </h1>
                            <p className="mt-1 text-[12px] text-secondary">
                                {formatBytes(info.fileSize)}
                                {info.expiresAt && !expired && (
                                    <>
                                        {" · "}
                                        {new Date(info.expiresAt).toLocaleDateString("zh-CN", {
                                            year: "numeric",
                                            month: "long",
                                            day: "numeric",
                                        })}
                                        {" 前有效"}
                                    </>
                                )}
                            </p>
                        </div>
                    </div>

                    {expired ? (
                        <p className="mt-6 rounded-xl bg-warning/5 px-3.5 py-3 text-[13px] text-warning">
                            该分享已过期。
                        </p>
                    ) : access ? (
                        <div className="mt-6 space-y-4">
                            {/* ── 图片 ── */}
                            {access.viewMode === "image" && (
                                <a
                                    href={access.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="点击查看原图"
                                    className="block overflow-hidden rounded-xl border border-border-subtle bg-[repeating-conic-gradient(#f3f4f6_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]"
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={access.url}
                                        alt={access.fileName}
                                        className="max-h-[65vh] w-full object-contain"
                                    />
                                </a>
                            )}
                            {/* ── 视频 ── */}
                            {access.viewMode === "video" && (
                                <video
                                    src={access.url}
                                    controls
                                    preload="metadata"
                                    className="max-h-[65vh] w-full rounded-xl border border-border-subtle bg-black"
                                />
                            )}
                            {/* ── 音频 ── */}
                            {access.viewMode === "audio" && (
                                <div className="rounded-xl border border-border-subtle bg-border-subtle/40 p-4">
                                    <audio src={access.url} controls className="w-full" />
                                </div>
                            )}
                            {/* ── PDF ── */}
                            {access.viewMode === "pdf" && (
                                <>
                                    <iframe
                                        src={access.url}
                                        title={access.fileName}
                                        className="h-[70vh] w-full rounded-xl border border-border-subtle"
                                    />
                                    <p className="text-center text-[11px] text-tertiary">
                                        如上方预览空白，请使用下方按钮下载后查看。
                                    </p>
                                </>
                            )}
                            {/* ── Markdown ── */}
                            {access.viewMode === "markdown" &&
                                (textPreview?.state === "loading" ? (
                                    <PreviewLoading />
                                ) : textPreview?.state === "ready" ? (
                                    <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-border-subtle bg-background px-5 py-4">
                                        <div className="note-prose">
                                            <Markdown>{textPreview.content}</Markdown>
                                        </div>
                                    </div>
                                ) : null)}
                            {/* ── 纯文本 / 代码 ── */}
                            {access.viewMode === "text" &&
                                (textPreview?.state === "loading" ? (
                                    <PreviewLoading />
                                ) : textPreview?.state === "ready" ? (
                                    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border-subtle bg-border-subtle/30 p-4 font-mono text-[12.5px] leading-relaxed text-foreground">
                                        {textPreview.content}
                                    </pre>
                                ) : null)}
                            {/* ── 无法展示 ── */}
                            {previewUnavailable && (
                                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-subtle bg-border-subtle/30 px-4 py-8 text-center">
                                    <FileWarning className="h-7 w-7 text-tertiary" />
                                    <p className="text-[13px] font-medium text-foreground">
                                        {unavailableHint}
                                    </p>
                                    <p className="text-[12px] text-tertiary">
                                        {access.viewMode === "html"
                                            ? "网页类文件不适合在线展示（安全考虑），请下载后打开。"
                                            : "请下载文件后在本地查看。"}
                                    </p>
                                </div>
                            )}
                            {/* ── 下载（预览成功与否都可用） ── */}
                            <button
                                type="button"
                                onClick={() => void unlock(true)}
                                disabled={unlocking}
                                className="btn-pill btn-primary flex h-11 w-full items-center justify-center gap-1.5 text-[13px] disabled:opacity-50 md:h-10"
                            >
                                {unlocking ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <CloudDownload className="h-4 w-4" />
                                )}
                                下载文件
                            </button>
                        </div>
                    ) : info.requiresCode ? (
                        <div className="mt-6 space-y-3">
                            <div className="flex items-center gap-2 text-[13px] text-secondary">
                                <Lock className="h-3.5 w-3.5" />
                                <span>此分享设置了提取码</span>
                            </div>
                            <div className="flex gap-2">
                                <input
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && code.trim()) void unlock();
                                    }}
                                    placeholder="输入提取码"
                                    maxLength={8}
                                    className="field h-10 flex-1 text-[16px] md:text-[14px]"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={() => void unlock()}
                                    disabled={unlocking || !code.trim()}
                                    className="btn-pill btn-primary flex h-11 w-24 items-center justify-center gap-1.5 text-[13px] disabled:opacity-50 md:h-10"
                                >
                                    {unlocking ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Unlock className="h-4 w-4" />
                                    )}
                                    提取
                                </button>
                            </div>
                            {accessError && (
                                <p className="text-[12px] text-danger">{accessError}</p>
                            )}
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void unlock()}
                            disabled={unlocking}
                            className="btn-pill btn-primary mt-6 flex h-11 w-full items-center justify-center gap-1.5 text-[13px] disabled:opacity-50 md:h-10"
                        >
                            {unlocking ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <CloudDownload className="h-4 w-4" />
                            )}
                            查看文件
                        </button>
                    )}
                </div>

                <p className="mt-8 text-center text-[11px] text-tertiary">
                    通过 MindBase 公开分享 · 内容由分享者提供
                </p>
            </div>
        </div>
    );
}

function PreviewLoading() {
    return (
        <div className="flex items-center justify-center rounded-xl border border-border-subtle bg-border-subtle/30 py-10">
            <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
        </div>
    );
}
