"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { authApi, type CaptchaResponse, type CaptchaValue } from "@/lib/api";

interface CaptchaFieldProps {
    onChange: (value: CaptchaValue) => void;
}

/**
 * 图形验证码输入（登录 / 发送邮箱验证码前的人机校验）。
 *
 * 每次校验（无论成败）验证码都会被后端一次性消费，父组件应在每次提交
 * 后 bump `key` 强制重挂载，即可自动刷新图片并清空输入。
 *
 * 后端降级（功能关闭 / Redis 不可用）返回 required=false 时本组件不渲染，
 * 空 captcha 字段由后端 fail-open 放行。
 */
export function CaptchaField({ onChange }: CaptchaFieldProps) {
    const [captcha, setCaptcha] = useState<CaptchaResponse | null>(null);
    const [code, setCode] = useState("");
    const [failed, setFailed] = useState(false);
    const onChangeRef = useRef(onChange);

    const refresh = useCallback(async () => {
        setFailed(false);
        setCaptcha(null);
        try {
            const data = await authApi.getCaptcha();
            setCaptcha(data);
            setCode("");
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        const t = setTimeout(() => {
            void refresh();
        }, 0);
        return () => clearTimeout(t);
    }, [refresh]);

    useEffect(() => {
        if (captcha && captcha.required) {
            onChangeRef.current({
                captcha_id: captcha.captcha_id,
                captcha_code: code.replace(/\s+/g, ""),
            });
        }
    }, [captcha, code]);

    // Gate degraded — nothing to fill in.
    if (captcha && !captcha.required) return null;

    return (
        <div className="flex gap-2">
            <input
                className="field"
                placeholder="图形验证码"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s+/g, ""))}
                maxLength={6}
                autoComplete="off"
                spellCheck={false}
            />
            <button
                type="button"
                onClick={refresh}
                title="点击刷新验证码"
                className="flex w-[124px] shrink-0 self-stretch items-center justify-center overflow-hidden rounded-[var(--radius)] border border-border bg-background transition-opacity hover:opacity-85"
            >
                {captcha ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={captcha.image_base64}
                        alt="图形验证码"
                        className="h-full w-full object-cover"
                    />
                ) : failed ? (
                    <span className="flex items-center gap-1 text-[12px] text-secondary">
                        <RefreshCw className="h-3.5 w-3.5" />
                        点击重试
                    </span>
                ) : (
                    <span className="text-[12px] text-tertiary">加载中…</span>
                )}
            </button>
        </div>
    );
}
