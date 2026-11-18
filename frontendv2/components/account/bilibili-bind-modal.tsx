/**
 * BilibiliBindModal - 已登录用户扫码绑定/刷新 B 站授权.
 *
 * Flow: GET /auth/qrcode → render QR → poll /auth/qrcode/poll/{key}?purpose=bind
 * (Bearer required, server binds the confirmed scan to the current uid).
 * Used by the account view (个人中心 B 站卡片) and the favorites view
 * (未绑定时的引导面板) — both via onBound so callers can refresh data.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { authApi, type QRCodeResponse } from "@/lib/api";

type BindStatus = "loading" | "ready" | "scanned" | "error";

interface BilibiliBindModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** 扫码确认绑定成功后回调（调用方刷新数据） */
    onBound: () => void;
    /** 视觉风格：个人中心用 google，收藏夹等 Apple 页面保持默认。 */
    variant?: "apple" | "google";
}

export function BilibiliBindModal({
    isOpen,
    onClose,
    onBound,
    variant = "apple",
}: BilibiliBindModalProps) {
    const google = variant === "google";
    const [qr, setQr] = useState<QRCodeResponse | null>(null);
    const [status, setStatus] = useState<BindStatus>("loading");
    const [statusText, setStatusText] = useState("");
    const [polling, setPolling] = useState(false);
    const boundRef = useRef(false);

    const getQR = useCallback(async () => {
        setPolling(false);
        setStatus("loading");
        setStatusText("");
        setQr(null);
        try {
            const data = await authApi.getQRCode();
            setQr(data);
            setStatus("ready");
            setPolling(true);
        } catch (err) {
            setStatus("error");
            setStatusText(err instanceof Error ? err.message : "二维码加载失败，请稍后重试");
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        boundRef.current = false;
        const t = setTimeout(getQR, 0);
        return () => clearTimeout(t);
    }, [isOpen, getQR]);

    // Poll with purpose=bind — the server binds the confirmed scan to the
    // current session uid (401 here means the session itself expired).
    useEffect(() => {
        if (!isOpen || !polling || !qr) return;
        const timer = setInterval(async () => {
            try {
                const res = await authApi.pollQRCodeForBinding(qr.qrcode_key);
                if (res.status === "scanned") {
                    setStatus("scanned");
                } else if (res.status === "confirmed") {
                    if (boundRef.current) return;
                    boundRef.current = true;
                    setPolling(false);
                    onBound();
                } else if (res.status === "expired") {
                    setPolling(false);
                    setStatus("error");
                    setStatusText("二维码已过期，请重新获取");
                }
            } catch {
                /* transient poll errors — keep polling */
            }
        }, 2000);
        return () => clearInterval(timer);
    }, [isOpen, polling, qr, onBound]);

    // 关闭时轮询 effect 会清理定时器；重开时 getQR 会重置状态。
    if (!isOpen || typeof document === "undefined") return null;

    return createPortal(
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                >
                    <div
                        className={cn(
                            "absolute inset-0",
                            google ? "bg-black/40" : "bg-black/30 backdrop-blur-sm",
                        )}
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className={cn(
                            "relative w-full max-w-[360px] border bg-surface",
                            google
                                ? "rounded-[12px] border-[#dadce0] bg-white p-6 shadow-[0_8px_24px_rgba(60,64,67,0.24)]"
                                : "rounded-[18px] border-border p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
                        )}
                    >
                        <button
                            onClick={onClose}
                            className={cn(
                                "absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full transition-colors",
                                google
                                    ? "text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]"
                                    : "text-secondary hover:bg-border-subtle hover:text-foreground",
                            )}
                        >
                            <X className="h-4 w-4" />
                        </button>

                        <h2
                            className={cn(
                                "text-[18px] text-foreground",
                                google ? "font-medium text-[#202124]" : "font-semibold tracking-tight",
                            )}
                        >
                            绑定 B 站账号
                        </h2>
                        <p className={cn("mt-1", google ? "text-[12px] text-[#5f6368]" : "text-[13px] text-secondary")}>
                            使用哔哩哔哩 APP 扫描二维码
                        </p>

                        <div className="mt-5 flex flex-col items-center">
                            <div
                                className={cn(
                                    "grid h-44 w-44 place-items-center overflow-hidden border",
                                    google
                                        ? "rounded-lg border-[#dadce0] bg-[#f8f9fa]"
                                        : "rounded-2xl border-border bg-background",
                                )}
                            >
                                {status === "loading" && (
                                    <span className="text-[13px] text-secondary">加载二维码…</span>
                                )}
                                {status === "error" ? (
                                    <div className="flex flex-col items-center gap-3 px-4">
                                        <span
                                            className={cn(
                                                "text-center",
                                                google ? "text-[12px] text-[#d93025]" : "text-[13px] text-danger",
                                            )}
                                        >
                                            {statusText || "二维码加载失败"}
                                        </span>
                                        <button
                                            onClick={getQR}
                                            className={
                                                google
                                                    ? "inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-[#0b57d0] transition-colors hover:bg-[#f1f3f4]"
                                                    : "btn-pill btn-ghost h-8 px-4 text-[12px]"
                                            }
                                        >
                                            重新获取
                                        </button>
                                    </div>
                                ) : (
                                    qr && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={qr.qrcode_image_base64}
                                            alt="绑定二维码"
                                            className={`h-full w-full object-contain transition-opacity ${status === "scanned" ? "opacity-40" : "opacity-100"}`}
                                        />
                                    )
                                )}
                            </div>
                            <p className={cn("mt-4", google ? "text-[12px] text-[#5f6368]" : "text-[13px] text-secondary")}>
                                {status === "scanned" && "已扫描，请在手机上确认"}
                                {status === "ready" && "扫码后将在手机上确认绑定"}
                                {status === "loading" && "正在获取二维码"}
                            </p>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}
