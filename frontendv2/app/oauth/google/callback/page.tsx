"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { authApi } from "@/lib/api";

function CallbackInner() {
    const params = useSearchParams();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const code = params.get("code");
        const state = params.get("state");
        const oauthError = params.get("error");
        if (oauthError) {
            const message = params.get("error_description") || "Google 授权被取消";
            setError(message);
            window.opener?.postMessage({ source: "google-callback", error: message }, window.location.origin);
            return;
        }
        if (!code || !state) {
            const message = "Google 回调缺少 code/state";
            setError(message);
            window.opener?.postMessage({ source: "google-callback", error: message }, window.location.origin);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const result = await authApi.googleLogin(code, state);
                if (cancelled) return;
                if (window.opener) {
                    window.opener.postMessage(
                        { source: "google-callback", sessionToken: result.session_token, user: result.user_info },
                        window.location.origin,
                    );
                    window.close();
                    return;
                }
                localStorage.setItem("session_token", result.session_token);
                localStorage.setItem("auth_user", JSON.stringify(result.user_info));
                if (typeof result.user_info.uid === "number") {
                    localStorage.setItem("auth_uid", String(result.user_info.uid));
                }
                if (result.user_info.avatar) localStorage.setItem("auth_avatar", result.user_info.avatar);
                window.location.replace("/");
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : "Google 登录失败";
                setError(message);
                window.opener?.postMessage({ source: "google-callback", error: message }, window.location.origin);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [params]);

    return (
        <main className="g-account flex min-h-[100dvh] items-center justify-center bg-[#f8f9fa] px-4">
            <div className="w-full max-w-[420px] rounded-xl border border-[#dadce0] bg-white px-8 py-10 text-center shadow-[0_12px_32px_rgba(32,33,36,0.10)]">
                <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-[#0b57d0] text-[17px] font-semibold text-white">M</div>
                <h1 className="mt-5 text-[20px] font-normal text-[#202124]">Google 登录</h1>
                <p className="mt-2 text-[13px] leading-6 text-[#5f6368]">
                    {error ?? "正在完成 Google 账号授权…"}
                </p>
                {error && (
                    <button
                        type="button"
                        onClick={() => window.close()}
                        className="mt-5 h-9 rounded-md bg-[#0b57d0] px-4 text-[13px] font-medium text-white"
                    >
                        关闭窗口
                    </button>
                )}
            </div>
        </main>
    );
}

export default function GoogleCallbackPage() {
    return (
        <Suspense fallback={null}>
            <CallbackInner />
        </Suspense>
    );
}
