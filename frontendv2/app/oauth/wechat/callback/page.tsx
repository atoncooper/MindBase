"use client";

/**
 * WeChat OAuth redirect target.
 *
 * WxLogin.js runs with self_redirect=true, so after the user scans and
 * confirms, WeChat navigates the embedded iframe to this page with
 * ?code=...&state=.... This page hands the one-time code/state to the
 * opener window (the login modal) via postMessage — the token exchange
 * happens there over an authenticated XHR, keeping session tokens out of
 * URLs.
 */
import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function CallbackInner() {
    const params = useSearchParams();
    const code = params.get("code");
    const state = params.get("state");

    useEffect(() => {
        if (!code || !state) return;
        window.parent.postMessage({ source: "wechat-callback", code, state }, window.location.origin);
    }, [code, state]);

    return (
        <div className="flex min-h-screen items-center justify-center">
            <p className="text-[14px] text-secondary">
                {code && state ? "正在完成微信登录…" : "微信登录回调参数缺失，请关闭后重新扫码"}
            </p>
        </div>
    );
}

export default function WeChatCallbackPage() {
    return (
        <Suspense fallback={null}>
            <CallbackInner />
        </Suspense>
    );
}
