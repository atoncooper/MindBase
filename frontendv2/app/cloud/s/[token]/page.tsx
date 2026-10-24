"use client";

/**
 * Public cloud share reading page (/cloud/s/<token>). No auth, no NavBar —
 * an anonymous visitor lander: file/folder metadata, extraction-code gate,
 * inline preview (image / video / audio / pdf / text / markdown), an explicit
 * "cannot preview" state for everything else, and download. All API calls
 * go through cloudApi's anonymous same-origin wrappers (lib/api/cloud.ts) —
 * components never fetch raw endpoints themselves (plan/1.0.16 §6).
 *
 * plan/1.0.16 新增：
 *  - targetType=folder → 列出 files，逐个预览/下载走 access {fileId}；
 *  - 顶部「保存到我的云盘」：未登录 → 弹登录引导；已登录 → POST /cloud/refs
 *    （保存为引用，不复制对象、不占配额；简化：存入根目录）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { cloudApi, formatBytes, type CloudAttestation, type CloudSharePublicFile } from "@/lib/api/cloud";
import { computeDeviceFingerprint, isAutomationEnv } from "@/lib/device-attest";
import { useAuth } from "@/lib/auth";
import { emitAppToast } from "@/lib/app-toast";
import { LoginModal } from "@/components/login-modal";
import type { UserInfo } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import {
    AlertCircle,
    CloudDownload,
    Copy,
    Check,
    File as FileIcon,
    FileImage,
    FileText,
    FileVideo,
    FileWarning,
    Folder,
    Loader2,
    Lock,
    Music,
    Save,
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
    const auth = useAuth();

    const [info, setInfo] = useState<SharedInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [code, setCode] = useState("");
    const [unlocking, setUnlocking] = useState(false);
    // 逐文件操作时的 loading id（folder 列表按行转圈）
    const [unlockingFileId, setUnlockingFileId] = useState<number | null>(null);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [access, setAccess] = useState<SharedAccess | null>(null);
    // 设备证明票据（attest 签发，绑定 token + 指纹）
    const [attestation, setAttestation] = useState<CloudAttestation | null>(null);
    // 文本类预览内容（text/markdown 拉取 presigned URL 的正文渲染）
    const [textPreview, setTextPreview] = useState<TextPreviewState | null>(null);

    // ── 保存到我的云盘（引用）──
    const [saving, setSaving] = useState(false);
    const [savedOk, setSavedOk] = useState(false);
    const [loginOpen, setLoginOpen] = useState(false);
    // 登录成功后自动续做「保存」
    const pendingSaveRef = useRef(false);

    useEffect(() => {
        if (!token) {
            // 缺 token 是同步可判定的前置错误：直接进入错误态，不发请求。
            // eslint-disable-next-line react-hooks/set-state-in-effect
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
        async (body: { code?: string; download?: boolean; fileId?: number }): Promise<SharedAccess> => {
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

    const triggerDownload = (url: string) => {
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    /** 单文件分享：提取（预览）或下载 */
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
                    triggerDownload(data.url);
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

    /** folder 分享：指定条目预览/下载（access body 携带 fileId） */
    const unlockFile = useCallback(
        async (fileId: number, download = false) => {
            if (!token) return;
            setUnlockingFileId(download ? -fileId : fileId);
            setAccessError(null);
            try {
                const data = await doAccess({
                    ...(code.trim() ? { code: code.trim() } : {}),
                    fileId,
                    download,
                });
                if (download) {
                    triggerDownload(data.url);
                    return;
                }
                setTextPreview(null);
                setAccess(data);
            } catch (e) {
                setAccessError(e instanceof Error ? e.message : "提取失败");
            } finally {
                setUnlockingFileId(null);
            }
        },
        [token, code, doAccess]
    );

    // ── 保存到我的云盘（引用，非复制） ──
    const saveToDrive = useCallback(async () => {
        if (!info || saving) return;
        if (auth.status !== "authenticated") {
            pendingSaveRef.current = true;
            setLoginOpen(true);
            return;
        }
        setSaving(true);
        try {
            const res = await cloudApi.saveShareToDrive({
                token,
                ...(info.requiresCode && code.trim() ? { code: code.trim() } : {}),
            });
            setSavedOk(true);
            emitAppToast("success", `已保存为引用（不占空间）${res.saved > 1 ? `，共 ${res.saved} 项` : ""}`);
        } catch (e) {
            emitAppToast("error", e instanceof Error ? e.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    }, [info, saving, auth.status, token, code]);

    const handleLoginSuccess = useCallback(
        (sessionToken: string, user: UserInfo) => {
            // auth.login 持久化 token（AuthProvider 是全站登录态唯一来源）
            auth.login(sessionToken, user);
            setLoginOpen(false);
            if (pendingSaveRef.current) {
                pendingSaveRef.current = false;
                void saveToDrive();
            }
        },
        [auth, saveToDrive],
    );

    // 文本类预览：access 成功后拉取正文（presigned URL 的 disposition 不影响
    // fetch 读体；超限或拉取失败 → 落到"无法展示"卡片 + 下载按钮）
    useEffect(() => {
        if (!access || !isTextualView(access.viewMode) || access.fileSize > TEXT_PREVIEW_CAP) {
            // 清掉上一份 access 的正文，避免切换文件时闪现旧内容。
            // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const isFolder = info.targetType === "folder";
    const files = isFolder ? (info.files ?? []) : [];
    // 过期与否按“当前时刻”展示（与后端 expiresAt 比较），只影响展示分支。
    // eslint-disable-next-line react-hooks/purity
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

                {/* ── 保存到我的云盘（引用） ── */}
                {!expired && (
                    <div className="mb-4 flex flex-col items-end gap-1.5">
                        <button
                            type="button"
                            onClick={() => void saveToDrive()}
                            disabled={saving || savedOk}
                            title={savedOk ? "已保存，可在云盘查看" : "保存为引用，不占用云盘空间"}
                            className="btn-pill btn-ghost flex h-9 items-center justify-center gap-1.5 px-4 text-[12px] disabled:opacity-60"
                        >
                            {saving ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : savedOk ? (
                                <Check className="h-3.5 w-3.5" />
                            ) : (
                                <Save className="h-3.5 w-3.5" />
                            )}
                            {savedOk ? "已保存到我的云盘" : "保存到我的云盘"}
                        </button>
                        <p className="text-[11px] text-tertiary">
                            {savedOk
                                ? "已保存为引用（不占空间）· 可在云盘「全部文件」根目录查看"
                                : "保存的是引用，不占用云盘空间 · 将存入「全部文件」根目录"}
                        </p>
                    </div>
                )}

                {/* 文件 / 文件夹卡片 */}
                <div className="rounded-2xl border border-border bg-surface p-6 shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
                    <div className="flex items-start gap-4">
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                            {isFolder ? <Folder className="h-6 w-6" /> : (() => { const IconComp = fileIcon(info.mimeType); return <IconComp className="h-6 w-6" />; })()}
                        </span>
                        <div className="min-w-0 flex-1">
                            <h1 className="break-all text-[17px] font-semibold leading-snug text-foreground">
                                {isFolder ? (info.folderName ?? "共享文件夹") : info.fileName}
                            </h1>
                            <p className="mt-1 text-[12px] text-secondary">
                                {isFolder
                                    ? `${files.length} 个文件${info.truncated ? "（仅列出前 2000 个）" : ""}`
                                    : formatBytes(info.fileSize)}
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
                    ) : isFolder ? (
                        <FolderShareBody
                            files={files}
                            requiresCode={info.requiresCode}
                            code={code}
                            onCodeChange={setCode}
                            onUnlock={() => void unlock()}
                            unlocking={unlocking}
                            unlockingFileId={unlockingFileId}
                            accessError={accessError}
                            onPreview={(f) => void unlockFile(f.fileId)}
                            onDownload={(f) => void unlockFile(f.fileId, true)}
                        />
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

            {/* 登录引导（保存前未登录） */}
            <LoginModal
                isOpen={loginOpen}
                onClose={() => {
                    pendingSaveRef.current = false;
                    setLoginOpen(false);
                }}
                onSuccess={handleLoginSuccess}
            />
        </div>
    );
}

/** folder 分享的文件列表 + 提取码门（plan/1.0.16 §6） */
function FolderShareBody({
    files,
    requiresCode,
    code,
    onCodeChange,
    onUnlock,
    unlocking,
    unlockingFileId,
    accessError,
    onPreview,
    onDownload,
}: {
    files: CloudSharePublicFile[];
    requiresCode: boolean;
    code: string;
    onCodeChange: (v: string) => void;
    onUnlock: () => void;
    unlocking: boolean;
    unlockingFileId: number | null;
    accessError: string | null;
    onPreview: (file: CloudSharePublicFile) => void;
    onDownload: (file: CloudSharePublicFile) => void;
}) {
    const [copiedId, setCopiedId] = useState<number | null>(null);

    const copyCode = () => {
        void navigator.clipboard.writeText(code);
        setCopiedId(0);
        setTimeout(() => setCopiedId(null), 1500);
    };

    return (
        <div className="mt-6 space-y-4">
            {requiresCode && (
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-[13px] text-secondary">
                        <Lock className="h-3.5 w-3.5" />
                        <span>此分享设置了提取码</span>
                    </div>
                    <div className="flex gap-2">
                        <input
                            value={code}
                            onChange={(e) => onCodeChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && code.trim()) onUnlock();
                            }}
                            placeholder="输入提取码"
                            maxLength={8}
                            className="field h-10 flex-1 text-[16px] md:text-[14px]"
                        />
                        <button
                            type="button"
                            onClick={onUnlock}
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
                        {code.trim() && (
                            <button
                                type="button"
                                onClick={copyCode}
                                title="复制提取码"
                                aria-label="复制提取码"
                                className="grid h-11 w-10 shrink-0 place-items-center rounded-[var(--radius)] border border-border text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                {copiedId === 0 ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            </button>
                        )}
                    </div>
                    {accessError && <p className="text-[12px] text-danger">{accessError}</p>}
                    <p className="text-[11px] text-tertiary">验证提取码后即可预览 / 下载下方文件。</p>
                </div>
            )}
            {files.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-tertiary">此文件夹没有可分享的文件</p>
            ) : (
                <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
                    {files.map((f) => {
                        const IconComp = fileIcon(f.mimeType);
                        const busy = unlockingFileId === f.fileId || unlockingFileId === -f.fileId;
                        return (
                            <li
                                key={f.fileId}
                                className="flex items-center gap-3 px-3 py-2.5"
                            >
                                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                                    <IconComp className="h-4 w-4" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] text-foreground" title={f.name}>
                                        {f.name}
                                    </p>
                                    <p className="mt-0.5 truncate text-[11px] text-tertiary">
                                        {f.path ? `${f.path} · ` : ""}
                                        {formatBytes(f.size)}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-[12px]">
                                    <button
                                        type="button"
                                        onClick={() => onPreview(f)}
                                        disabled={busy}
                                        className="rounded-md px-2 py-1 text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
                                    >
                                        {unlockingFileId === f.fileId ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            "预览"
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDownload(f)}
                                        disabled={busy}
                                        className="rounded-md px-2 py-1 text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
                                    >
                                        {unlockingFileId === -f.fileId ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            "下载"
                                        )}
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {accessError && !requiresCode && (
                <p className="text-[12px] text-danger">{accessError}</p>
            )}
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
