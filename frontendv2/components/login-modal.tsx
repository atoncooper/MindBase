"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { authApi, type QRCodeResponse, type UserInfo } from "@/lib/api";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (sessionToken: string, user: UserInfo) => void;
}

type Tab = "qr" | "password";
type QRStatus = "loading" | "ready" | "scanned" | "success" | "error";

export function LoginModal({ isOpen, onClose, onSuccess }: LoginModalProps) {
  const [tab, setTab] = useState<Tab>("qr");

  // QR state
  const [qr, setQr] = useState<QRCodeResponse | null>(null);
  const [qrStatus, setQrStatus] = useState<QRStatus>("loading");
  const [polling, setPolling] = useState(false);

  // Password state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");

  const getQR = useCallback(async () => {
    setQrStatus("loading");
    try {
      const data = await authApi.getQRCode();
      setQr(data);
      setQrStatus("ready");
      setPolling(true);
    } catch {
      setQrStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!isOpen || tab !== "qr") return;
    const t = setTimeout(getQR, 0);
    return () => clearTimeout(t);
  }, [isOpen, tab, getQR]);

  useEffect(() => {
    if (!isOpen || tab !== "qr" || !polling || !qr) return;
    const timer = setInterval(async () => {
      try {
        const res = await authApi.pollQRCode(qr.qrcode_key);
        if (res.status === "scanned") setQrStatus("scanned");
        else if (res.status === "confirmed") {
          setPolling(false);
          setQrStatus("success");
          const token = res.user_info?.session_token || res.session_id || "";
          setTimeout(() => onSuccess(token, res.user_info!), 500);
        } else if (res.status === "expired") {
          setPolling(false);
          setQrStatus("error");
        }
      } catch {
        /* keep polling on transient network errors */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isOpen, tab, polling, qr, onSuccess]);

  // Reset on close. The modal stays mounted (returns null when closed), so we
  // clear stale QR/polling state here rather than on each open trigger.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset transient form state when the modal closes; no cascading renders
      setPolling(false);
      setQr(null);
      setQrStatus("loading");
      setPwError("");
    }
  }, [isOpen]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwLoading(true);
    try {
      const res = await authApi.login(email, password);
      onSuccess(res.session_token, res.user_info);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "登录失败，请重试");
    } finally {
      setPwLoading(false);
    }
  };

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
            className="relative w-full max-w-[400px] rounded-[18px] border border-border bg-surface p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            <h2 className="text-[22px] font-semibold tracking-tight text-foreground">登录 MindBase</h2>
            <p className="mt-1 text-[13px] text-secondary">把收藏变成可对话的知识</p>

            {/* Tabs */}
            <div className="mt-6 flex gap-1 rounded-full bg-border-subtle p-1">
              {(["qr", "password"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-full py-1.5 text-[13px] font-medium transition-colors ${
                    tab === t ? "bg-surface text-foreground shadow-sm" : "text-secondary hover:text-foreground"
                  }`}
                >
                  {t === "qr" ? "扫码登录" : "账号登录"}
                </button>
              ))}
            </div>

            {/* QR panel */}
            {tab === "qr" && (
              <div className="mt-6 flex flex-col items-center">
                <div className="grid h-44 w-44 place-items-center overflow-hidden rounded-2xl border border-border bg-background">
                  {qrStatus === "loading" && (
                    <span className="text-[13px] text-secondary">加载二维码…</span>
                  )}
                  {qrStatus === "error" && (
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-[13px] text-danger">二维码已失效</span>
                      <button onClick={getQR} className="btn-pill btn-ghost h-8 px-4 text-[12px]">
                        重新获取
                      </button>
                    </div>
                  )}
                  {qr && (qrStatus === "ready" || qrStatus === "scanned" || qrStatus === "success") && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qr.qrcode_image_base64}
                      alt="登录二维码"
                      className={`h-full w-full object-contain transition-opacity ${
                        qrStatus === "scanned" || qrStatus === "success" ? "opacity-40" : "opacity-100"
                      }`}
                    />
                  )}
                </div>
                <p className="mt-4 text-[13px] text-secondary">
                  {qrStatus === "scanned" && "已扫描，请在手机上确认"}
                  {qrStatus === "success" && "登录成功，正在进入…"}
                  {(qrStatus === "ready" || qrStatus === "loading") && "使用哔哩哔哩 APP 扫描二维码"}
                </p>
              </div>
            )}

            {/* Password panel */}
            {tab === "password" && (
              <form onSubmit={handlePasswordLogin} className="mt-6 flex flex-col gap-3">
                <input
                  type="email"
                  className="field"
                  placeholder="邮箱"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
                <input
                  type="password"
                  className="field"
                  placeholder="密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                {pwError && <p className="text-[12px] text-danger">{pwError}</p>}
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="btn-pill btn-primary mt-1 h-10 text-[14px]"
                >
                  {pwLoading ? "登录中…" : "登录"}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
