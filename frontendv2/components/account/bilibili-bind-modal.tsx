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
import { authApi, type QRCodeResponse } from "@/lib/api";

type BindStatus = "loading" | "ready" | "scanned" | "error";

interface BilibiliBindModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** 扫码确认绑定成功后回调（调用方刷新数据） */
    onBound: () => void;
}

export function BilibiliBindModal({ isOpen, onClose, onBound }: BilibiliBindModalProps) {
    const [qr, setQr] = useState<QRCodeResponse | null>(null);
    const [status, setStatus] = useState<BindStatus>("loading");
    const [statusText, setStatusText] = useState("");
    const [polling, setPolling] = useState(false);
    const boundRef = useRef(false);

    const getQR = useCallback(async () => {
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

    // Reset on close.
    useEffect(() => {
        if (!isOpen) {
            setPolling(false);
            setQr(null);
            setStatus("loading");
            setStatusText("");
        }
    }, [isOpen]);

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
                        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className="relative w-full max-w-[360px] rounded-[18px] border border-border bg-surface p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]"
                    >
                        <button
                            onClick={onClose}
                            className="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                        >
                            <X className="h-4 w-4" />
                        </button>

                        <h2 className="text-[18px] font-semibold tracking-tight text-foreground">绑定 B 站账号</h2>
                        <p className="mt-1 text-[13px] text-secondary">使用哔哩哔哩 APP 扫描二维码</p>

                        <div className="mt-5 flex flex-col items-center">
                            <div className="grid h-44 w-44 place-items-center overflow-hidden rounded-2xl border border-border bg-background">
                                {status === "loading" && (
                                    <span className="text-[13px] text-secondary">加载二维码…</span>
                                )}
                                {status === "error" ? (
                                    <div className="flex flex-col items-center gap-3 px-4">
                                        <span className="text-center text-[13px] text-danger">{statusText || "二维码加载失败"}</span>
                                        <button onClick={getQR} className="btn-pill btn-ghost h-8 px-4 text-[12px]">
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
                            <p className="mt-4 text-[13px] text-secondary">
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
