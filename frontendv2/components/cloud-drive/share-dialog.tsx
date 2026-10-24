"use client";

/**
 * Share dialog — create/copy/revoke Baidu-style share links for one file OR
 * one folder (plan/1.0.16 §6). Extraction code (optional), expiry (days),
 * download cap. The share URL is an anonymous route (/cloud/s/<token>).
 *
 * 合规警告前置：首次打开时弹出《分享规范》+《内容审核说明》，合并为单一
 * 勾选确认（用户点击「同意并继续」后把确认状态写入 localStorage，按政策版本
 * 号），同一浏览器后续打开分享弹窗不再重复显示该警告层；创建请求固定带
 * legalAck + contentReviewAck: true（app-cloud 强制校验，缺省 422）。
 *
 * 视觉：Google Material 3 —— 实色 scrim、28px 对话框圆角、容器化图标、
 * 选择行状态层（surface-container → secondary-container）、胶囊按钮，
 * 与 quiz 域同一套 Google 语言。
 *
 * 结构：整棵弹窗 createPortal 到 body。警告层与分享主体是「同一个 scrim 下
 * 的二选一视图」（AnimatePresence mode="wait"），不嵌套对话框 —— 嵌套会让
 * 28px 圆角与阴影被父级 16px 圆角 + overflow-hidden 裁切，四周漏出底层表单。
 *
 * The body is a keyed child mounted per-open — all dialog state resets via
 * unmount (no state-sync effects).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, Copy, Link2, Loader2, Lock, Scale, ShieldAlert, X } from "lucide-react";
import { cloudApi, type CloudShareView } from "@/lib/api/cloud";
import { getShareBaseUrl } from "@/lib/api/share";
import { Select } from "@/components/ui/select";

export type ShareDialogTarget =
    | { type: "file"; uploadUuid: string }
    | { type: "folder"; folderId: number };

interface ShareDialogProps {
    open: boolean;
    /** 文件或文件夹分享目标（null = 不渲染） */
    target: ShareDialogTarget | null;
    fileName: string;
    onClose: () => void;
}

export function ShareDialog({ open, target, fileName, onClose }: ShareDialogProps) {
    const targetKey =
        target?.type === "file" ? `file-${target.uploadUuid}` : target ? `folder-${target.folderId}` : "";
    // portal 到 body：避开页面 transform 祖先（会让 fixed 失效）与父级 overflow 裁切。
    if (!open || !target || typeof document === "undefined") return null;
    return createPortal(
        <AnimatePresence>
            <ShareDialogBody key={targetKey} target={target} fileName={fileName} onClose={onClose} />
        </AnimatePresence>,
        document.body,
    );
}

const WARNINGS = [
    "分享内容将公开可访问，你必须遵守《中华人民共和国网络安全法》等法律法规；",
    "严禁制作、复制、发布、传播任何违法内容（含侵权、色情、暴恐、谣言等）；",
    "违规分享的法律责任由分享者本人承担；平台可依法审核并封禁违规内容。",
];

// 内容审核告知（第二条单独确认，与上方规范确认分开留档）
const REVIEW_NOTICE = [
    "为处理举报与违法内容，平台管理员可依法查看本分享的文件内容用于审核；",
    "审核为受控预览，不提供原文件下载，且每次查看都会记录审计日志。",
];

const ACK_POLICY_VERSION = "2026-10-v1";
const ACK_STORAGE_KEY = `mindbase:share:ack:${ACK_POLICY_VERSION}`;

function hasAckedSharePolicy(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(ACK_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function setAckedSharePolicy(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(ACK_STORAGE_KEY, "1");
    } catch {
        // ignore private-mode / quota
    }
}

/** M3 复选框视觉（18px 方形，选中填充主色）。需与前面的 `peer` input 同级。 */
function M3Checkbox({ checked }: { checked: boolean }) {
    return (
        <span
            aria-hidden
            className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[3px] border-2 transition-colors peer-focus-visible:ring-[3px] peer-focus-visible:ring-[rgba(11,87,208,0.32)] ${
                checked ? "border-[#0b57d0] bg-[#0b57d0] text-white" : "border-[#444746] bg-transparent text-transparent"
            }`}
        >
            <Check className="h-3 w-3" strokeWidth={3.5} />
        </span>
    );
}

/** M3 选择行：未选 surface-container，选中 secondary-container；整行可点。 */
function AckRow({
    checked,
    onChange,
    children,
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    children: ReactNode;
}) {
    return (
        <label
            className={`group mt-3 flex cursor-pointer items-start gap-3 rounded-2xl px-3.5 py-3 transition-colors ${
                checked ? "bg-[#d3e3fd]" : "bg-[#f0f4f9] hover:bg-[#e9eef6]"
            }`}
        >
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="peer sr-only"
            />
            <M3Checkbox checked={checked} />
            <span className={`text-[13px] leading-5 ${checked ? "text-[#041e49]" : "text-[#1f1f1f]"}`}>
                {children}
            </span>
        </label>
    );
}

function ShareDialogBody({
    target,
    fileName,
    onClose,
}: {
    target: ShareDialogTarget;
    fileName: string;
    onClose: () => void;
}) {
    const isFolder = target.type === "folder";
    const [shares, setShares] = useState<CloudShareView[]>([]);
    // starts true: the mount effect kicks off the initial fetch
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [useCode, setUseCode] = useState(false);
    const [code, setCode] = useState("");
    const [expiresInDays, setExpiresInDays] = useState(7);
    const [maxDownloads, setMaxDownloads] = useState("");
    const [copiedId, setCopiedId] = useState<number | string | null>(null);
    // ── 合规与审核告知：合并为一个确认项，首次打开时显示警告层 ──
    const alreadyAcked = hasAckedSharePolicy();
    const [policyAck, setPolicyAck] = useState(alreadyAcked);
    const [agreementConfirmed, setAgreementConfirmed] = useState(alreadyAcked);
    // 重设提取码（legacy 哈希行不可见 → 换新码；链接与 token 不变）
    const [resetCodeId, setResetCodeId] = useState<number | null>(null);
    const [resetCodeValue, setResetCodeValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    // 分享域名/公网 IP（/api/share-base），空则回退当前访问地址
    const [shareBase, setShareBase] = useState("");
    const acknowledgementsComplete = policyAck;

    useEffect(() => {
        void getShareBaseUrl().then((base) => {
            setShareBase(base || (typeof window !== "undefined" ? window.location.origin : ""));
        });
    }, []);

    const fullUrlFor = (token: string) => `${shareBase}/cloud/s/${token}`;

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = isFolder
                ? await cloudApi.listFolderShares(target.folderId)
                : await cloudApi.listShares(target.uploadUuid);
            setShares(res.shares);
        } catch {
            setShares([]);
        } finally {
            setLoading(false);
        }
    }, [isFolder, target]);

    useEffect(() => {
        // mount fetch: async body so no setState runs synchronously in the effect
        const run = async () => {
            await Promise.resolve();
            await refresh();
        };
        void run();
    }, [refresh]);

    const handleCreate = async () => {
        setBusy(true);
        setError(null);
        try {
            const trimmed = code.trim();
            if (useCode && trimmed.length < 3) {
                setError("提取码至少 3 位");
                return;
            }
            const md = maxDownloads.trim();
            if (md && (!Number.isFinite(Number(md)) || Number(md) < 1)) {
                setError("下载次数上限需为正整数，或留空不限");
                return;
            }
            // 合规警告 + 内容审核告知均已前置确认，创建请求固定带两个 ack
            const params = {
                ...(useCode && trimmed ? { code: trimmed } : {}),
                expiresInDays,
                ...(md ? { maxDownloads: Number(md) } : {}),
                legalAck: true,
                contentReviewAck: true,
            };
            const res = isFolder
                ? await cloudApi.createFolderShare(target.folderId, params)
                : await cloudApi.createShare(target.uploadUuid, params);
            setCopiedId(res.id ?? null); // 新链接直接进入列表并高亮复制态
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建失败");
        } finally {
            setBusy(false);
        }
    };

    const handleResetCode = async (id: number) => {
        if (resetCodeValue.trim().length < 3) return;
        setBusy(true);
        try {
            await cloudApi.updateShareCode(id, resetCodeValue.trim());
            setResetCodeId(null);
            setResetCodeValue("");
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "重设失败");
        } finally {
            setBusy(false);
        }
    };

    const handleRevoke = async (id: number) => {
        setBusy(true);
        try {
            await cloudApi.revokeShare(id);
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const copyLink = (id: number | string, url: string) => {
        void navigator.clipboard.writeText(url);
        setCopiedId(id);
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(32,33,36,0.5)] p-4"
            onClick={() => (busy ? undefined : onClose())}
        >
            {/* 警告层与分享主体二选一：同一个 scrim，不叠对话框 */}
            <AnimatePresence mode="wait">
                {!agreementConfirmed ? (
                    <motion.div
                        key="gate"
                        initial={{ opacity: 0, scale: 0.97, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 6 }}
                        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="share-agreement-title"
                        aria-describedby="share-agreement-desc"
                        onClick={(e) => e.stopPropagation()}
                        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-[28px] bg-white text-[#1f1f1f] shadow-[0_4px_4px_rgba(60,64,67,0.16),0_12px_32px_8px_rgba(60,64,67,0.16)]"
                    >
                        {/* 标题区 */}
                        <div className="flex shrink-0 items-start gap-3.5 px-6 pb-1 pt-6">
                            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#fef7e0] text-[#b06000]">
                                <ShieldAlert className="h-[22px] w-[22px]" strokeWidth={1.8} />
                            </span>
                            <div className="min-w-0 flex-1 pt-0.5">
                                <h3
                                    id="share-agreement-title"
                                    className="text-[22px] font-normal leading-7 tracking-[-0.01em] text-[#1f1f1f]"
                                >
                                    分享前请确认
                                </h3>
                                <p id="share-agreement-desc" className="mt-1.5 text-[13px] leading-5 text-[#444746]">
                                    分享链接公开可访问，任何人获得链接即可查看。请阅读并确认以下分享规范及内容审核说明。
                                </p>
                            </div>
                        </div>

                        {/* 正文：合并为单一确认区（不在对话框里再套卡片） */}
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-1 pt-4">
                            <section>
                                <div className="flex items-center gap-1.5">
                                    <Scale className="h-4 w-4 shrink-0 text-[#444746]" strokeWidth={1.8} />
                                    <h4 className="text-[13px] font-medium text-[#1f1f1f]">法律法规与分享责任</h4>
                                </div>
                                <ul className="mt-2 pl-6 text-[13px] leading-5 text-[#444746]">
                                    {WARNINGS.map((w) => (
                                        <li key={w} className="flex gap-2">
                                            <span aria-hidden className="select-none text-[#747775]">
                                                •
                                            </span>
                                            <span>{w}</span>
                                        </li>
                                    ))}
                                </ul>

                                <div className="my-4 h-px bg-[#e0e3e1]" />

                                <div className="flex items-center gap-1.5">
                                    <Lock className="h-4 w-4 shrink-0 text-[#444746]" strokeWidth={1.8} />
                                    <h4 className="text-[13px] font-medium text-[#1f1f1f]">内容审核说明</h4>
                                </div>
                                <ul className="mt-2 pl-6 text-[13px] leading-5 text-[#444746]">
                                    {REVIEW_NOTICE.map((w) => (
                                        <li key={w} className="flex gap-2">
                                            <span aria-hidden className="select-none text-[#747775]">
                                                •
                                            </span>
                                            <span>{w}</span>
                                        </li>
                                    ))}
                                </ul>
                                <AckRow checked={policyAck} onChange={setPolicyAck}>
                                    我已阅读并同意以上分享规范及内容审核说明
                                </AckRow>
                            </section>
                        </div>

                        {/* 动作区：文字按钮 + 填充按钮（M3） */}
                        <div className="flex shrink-0 flex-col gap-3 px-6 pb-5 pt-3 sm:flex-row sm:items-center sm:justify-between">
                            <span
                                aria-live="polite"
                                className="order-2 text-[12px] leading-4 text-[#747775] sm:order-1"
                            >
                                {acknowledgementsComplete ? "已完成确认" : "还需完成确认"}
                            </span>
                            <div className="order-1 flex items-center gap-2 sm:order-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="h-10 flex-1 rounded-full px-5 text-[13px] font-medium text-[#0b57d0] transition-colors hover:bg-[rgba(11,87,208,0.08)] sm:flex-none"
                                >
                                    取消分享
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setAckedSharePolicy();
                                        setAgreementConfirmed(true);
                                    }}
                                    disabled={!acknowledgementsComplete}
                                    className="h-10 flex-1 rounded-full bg-[#0b57d0] px-5 text-[13px] font-medium text-white transition-all enabled:hover:bg-[#0a4cb5] enabled:hover:shadow-[0_1px_2px_rgba(60,64,67,0.3),0_1px_3px_1px_rgba(60,64,67,0.15)] disabled:cursor-not-allowed disabled:bg-[rgba(31,31,31,0.12)] disabled:text-[rgba(31,31,31,0.38)] sm:flex-none"
                                >
                                    同意并继续
                                </button>
                            </div>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        key="main"
                        initial={{ opacity: 0, scale: 0.97, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, y: 10 }}
                        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="share-dialog-title"
                        onClick={(e) => e.stopPropagation()}
                        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-[28px] bg-white text-[#1f1f1f] shadow-[0_4px_4px_rgba(60,64,67,0.16),0_12px_32px_8px_rgba(60,64,67,0.16)]"
                    >
                        {/* 标题区 */}
                        <header className="flex shrink-0 items-start gap-3.5 px-6 pb-2 pt-6">
                            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#e8f0fe] text-[#0b57d0]">
                                <Link2 className="h-[22px] w-[22px]" strokeWidth={1.8} />
                            </span>
                            <div className="min-w-0 flex-1 pt-0.5">
                                <h2
                                    id="share-dialog-title"
                                    title={fileName}
                                    className="truncate text-[20px] font-normal leading-7 tracking-[-0.01em]"
                                >
                                    分享「{fileName}」
                                </h2>
                                <p className="mt-1 text-[13px] leading-5 text-[#444746]">
                                    任何获得链接的人都可以查看
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="关闭"
                                className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-full text-[#444746] transition-colors hover:bg-[rgba(31,31,31,0.06)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </header>

                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-4">
                            {/* 创建表单 */}
                            <section className="space-y-3">
                                <div className="flex items-center gap-3">
                                    <span className="w-[64px] shrink-0 text-[13px] text-[#444746]">有效期</span>
                                    <Select
                                        className="w-[140px]"
                                        value={String(expiresInDays)}
                                        onChange={(v) => setExpiresInDays(Number(v))}
                                        ariaLabel="有效期"
                                        options={[
                                            { value: "1", label: "1 天" },
                                            { value: "7", label: "7 天" },
                                            { value: "30", label: "30 天" },
                                            { value: "0", label: "永久" },
                                        ]}
                                    />
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="w-[64px] shrink-0 text-[13px] text-[#444746]">下载上限</span>
                                    <input
                                        type="number"
                                        min={1}
                                        value={maxDownloads}
                                        onChange={(e) => setMaxDownloads(e.target.value)}
                                        placeholder="不限"
                                        className="h-9 w-[140px] rounded-lg border border-[#c4c7c5] bg-white px-3 text-[13px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#747775] focus:border-[#0b57d0]"
                                    />
                                    <span className="text-[12px] text-[#747775]">留空即不限次数</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="w-[64px] shrink-0 text-[13px] text-[#444746]">提取码</span>
                                    <label className="flex cursor-pointer items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={useCode}
                                            onChange={(e) => setUseCode(e.target.checked)}
                                            className="peer sr-only"
                                        />
                                        <M3Checkbox checked={useCode} />
                                        <span className="text-[13px] text-[#1f1f1f]">启用</span>
                                    </label>
                                    {useCode && (
                                        <input
                                            value={code}
                                            onChange={(e) => setCode(e.target.value)}
                                            placeholder="至少 3 位"
                                            maxLength={8}
                                            className="h-9 w-[132px] rounded-lg border border-[#c4c7c5] bg-white px-3 font-mono text-[13px] tracking-wider text-[#1f1f1f] outline-none transition-colors placeholder:font-sans placeholder:tracking-normal placeholder:text-[#747775] focus:border-[#0b57d0]"
                                        />
                                    )}
                                </div>
                            </section>

                            {error && (
                                <div className="mt-4 flex items-start gap-2 rounded-lg bg-[#fce8e6] px-3 py-2 text-[12px] leading-5 text-[#d93025]">
                                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={() => void handleCreate()}
                                disabled={busy}
                                className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[#0b57d0] text-[14px] font-medium text-white transition-all enabled:hover:bg-[#0a4cb5] enabled:hover:shadow-[0_1px_2px_rgba(60,64,67,0.3),0_1px_3px_1px_rgba(60,64,67,0.15)] disabled:cursor-not-allowed disabled:bg-[rgba(31,31,31,0.12)] disabled:text-[rgba(31,31,31,0.38)]"
                            >
                                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                                创建分享链接
                            </button>

                            {/* 生效中的链接 */}
                            <div className="mt-6 h-px bg-[#e0e3e1]" />
                            <div className="mt-4 flex items-center justify-between">
                                <h3 className="text-[13px] font-medium text-[#1f1f1f]">生效中的链接</h3>
                                <span className="rounded-full bg-[#f0f4f9] px-2 py-0.5 text-[11px] font-medium text-[#444746]">
                                    {shares.length}
                                </span>
                            </div>

                            <div className="mt-3">
                                {loading ? (
                                    <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-[#747775]">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        正在加载…
                                    </div>
                                ) : shares.length === 0 ? (
                                    <div className="flex flex-col items-center gap-1 rounded-2xl bg-[#f8fafd] px-4 py-7 text-center">
                                        <Link2 className="h-5 w-5 text-[#9aa0a6]" strokeWidth={1.6} />
                                        <p className="mt-1 text-[13px] text-[#444746]">还没有生效的分享链接</p>
                                        <p className="text-[12px] text-[#747775]">创建后可随时复制或撤销</p>
                                    </div>
                                ) : (
                                    <ul className="space-y-2">
                                        {shares.map((sh) => {
                                            const url = sh.shareToken ? fullUrlFor(sh.shareToken) : "";
                                            const banned = sh.moderationStatus === "banned";
                                            return (
                                                <li
                                                    key={sh.id}
                                                    className="rounded-2xl border border-[#e0e3e1] px-3.5 py-3"
                                                >
                                                    <div className="flex items-start gap-2">
                                                        <Link2
                                                            className="mt-1 h-4 w-4 shrink-0 text-[#747775]"
                                                            strokeWidth={1.8}
                                                        />
                                                        <span
                                                            title={url}
                                                            className="min-w-0 flex-1 truncate text-[13px] leading-5 text-[#1f1f1f]"
                                                        >
                                                            {url || "（无 token）"}
                                                        </span>
                                                        {banned && (
                                                            <span className="shrink-0 rounded-full bg-[#fce8e6] px-2 py-0.5 text-[11px] font-medium text-[#d93025]">
                                                                已封禁
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* 提取码：明文可见可复制；legacy 哈希行 → 重设 */}
                                                    {sh.hasCode && (
                                                        <div className="mt-2 flex items-center gap-2 rounded-lg bg-[#f0f4f9] px-2.5 py-1.5">
                                                            <Lock
                                                                className="h-3.5 w-3.5 shrink-0 text-[#444746]"
                                                                strokeWidth={1.8}
                                                            />
                                                            {sh.extractionCode ? (
                                                                <>
                                                                    <span className="font-mono text-[12px] tracking-widest text-[#1f1f1f]">
                                                                        {sh.extractionCode}
                                                                    </span>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            copyLink(
                                                                                `code-${sh.id}`,
                                                                                sh.extractionCode ?? "",
                                                                            )
                                                                        }
                                                                        className="ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-[#0b57d0] transition-colors hover:bg-[rgba(11,87,208,0.08)]"
                                                                    >
                                                                        {copiedId === `code-${sh.id}` ? (
                                                                            <Check className="h-3.5 w-3.5" />
                                                                        ) : (
                                                                            <Copy className="h-3.5 w-3.5" />
                                                                        )}
                                                                        {copiedId === `code-${sh.id}` ? "已复制" : "复制"}
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setResetCodeId((cur) =>
                                                                            cur === sh.id ? null : sh.id,
                                                                        )
                                                                    }
                                                                    className="text-[12px] text-[#b06000] hover:underline"
                                                                >
                                                                    提取码不可见（旧格式）—— 点击重设
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}

                                                    {resetCodeId === sh.id && (
                                                        <div className="mt-2 flex gap-2">
                                                            <input
                                                                value={resetCodeValue}
                                                                onChange={(e) => setResetCodeValue(e.target.value)}
                                                                placeholder="新提取码（3 位以上）"
                                                                maxLength={16}
                                                                className="h-9 min-w-0 flex-1 rounded-lg border border-[#c4c7c5] bg-white px-3 text-[13px] text-[#1f1f1f] outline-none transition-colors placeholder:text-[#747775] focus:border-[#0b57d0]"
                                                            />
                                                            <button
                                                                type="button"
                                                                disabled={
                                                                    busy || resetCodeValue.trim().length < 3
                                                                }
                                                                onClick={() => void handleResetCode(sh.id)}
                                                                className="h-9 shrink-0 rounded-full bg-[#d3e3fd] px-4 text-[13px] font-medium text-[#041e49] transition-colors enabled:hover:shadow-[0_1px_2px_rgba(60,64,67,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
                                                            >
                                                                保存
                                                            </button>
                                                        </div>
                                                    )}

                                                    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                                        <span className="text-[12px] leading-5 text-[#747775]">
                                                            {sh.expiresAt
                                                                ? `至 ${new Date(sh.expiresAt).toLocaleDateString()}`
                                                                : "永久"}
                                                            {" · "}查看 {sh.viewCount} · 下载 {sh.downloadCount}
                                                        </span>
                                                        <div className="flex shrink-0 items-center gap-0.5">
                                                            {url && !banned && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => copyLink(sh.id, url)}
                                                                    className="flex h-8 items-center gap-1 rounded-full px-3 text-[12px] font-medium text-[#0b57d0] transition-colors hover:bg-[rgba(11,87,208,0.08)]"
                                                                >
                                                                    {copiedId === sh.id ? (
                                                                        <Check className="h-3.5 w-3.5" />
                                                                    ) : (
                                                                        <Copy className="h-3.5 w-3.5" />
                                                                    )}
                                                                    {copiedId === sh.id ? "已复制" : "复制链接"}
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => void handleRevoke(sh.id)}
                                                                disabled={busy}
                                                                className="h-8 rounded-full px-3 text-[12px] font-medium text-[#d93025] transition-colors hover:bg-[rgba(217,48,37,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
                                                            >
                                                                撤销
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {banned && sh.moderationReason && (
                                                        <p className="mt-1 text-[12px] leading-5 text-[#d93025]">
                                                            封禁原因：{sh.moderationReason}
                                                        </p>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
