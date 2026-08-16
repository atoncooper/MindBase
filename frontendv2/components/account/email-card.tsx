"use client";

import { useEffect, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { userApi, type CaptchaValue, type ProfileData } from "@/lib/api";
import { CaptchaField } from "@/components/captcha-field";
import {
    FormCard,
    EditButton,
    CancelButton,
    PrimaryButton,
    Tag,
} from "./form-card";

interface Props {
    profile: ProfileData;
    onReload: () => void;
    onToast: (msg: string, type: "success" | "error") => void;
}

export function EmailCard({ profile, onReload, onToast }: Props) {
    const [editing, setEditing] = useState(false);
    const [emailVal, setEmailVal] = useState("");
    const [code, setCode] = useState("");
    const [sending, setSending] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [verifying, setVerifying] = useState(false);

    // Captcha for the send-code request. Bumping captchaKey remounts
    // CaptchaField with a fresh image (each send consumes the captcha).
    const [captcha, setCaptcha] = useState<CaptchaValue>({ captcha_id: "", captcha_code: "" });
    const [captchaKey, setCaptchaKey] = useState(0);

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
        return () => clearInterval(t);
    }, [cooldown]);

    function enterEdit() {
        setEmailVal(profile.email ?? "");
        setCode("");
        setCooldown(0);
        setEditing(true);
    }

    async function sendCode() {
        if (!emailVal.trim() || cooldown > 0) return;
        setSending(true);
        try {
            await userApi.sendEmailCode({
                email: emailVal.trim(),
                purpose: "bind_email",
                captcha_id: captcha.captcha_id || undefined,
                captcha_code: captcha.captcha_code || undefined,
            });
            setCooldown(60);
            onToast("验证码已发送，请查收邮件", "success");
        } catch (e) {
            onToast(e instanceof Error ? e.message : "发送失败", "error");
        } finally {
            setSending(false);
            // The captcha was consumed regardless of outcome.
            setCaptchaKey((k) => k + 1);
        }
    }

    async function verify() {
        if (!emailVal.trim() || !code.trim()) {
            onToast("请填写邮箱和验证码", "error");
            return;
        }
        setVerifying(true);
        try {
            await userApi.verifyEmail({
                email: emailVal.trim(),
                code: code.trim(),
                purpose: "bind_email",
            });
            setEditing(false);
            setCode("");
            setCooldown(0);
            onToast("邮箱已验证并绑定", "success");
            onReload();
        } catch (e) {
            onToast(e instanceof Error ? e.message : "验证失败", "error");
        } finally {
            setVerifying(false);
        }
    }

    async function unbind() {
        try {
            await userApi.unbindEmail();
            onToast("邮箱已解绑", "success");
            onReload();
        } catch (e) {
            onToast(e instanceof Error ? e.message : "解绑失败", "error");
        }
    }

    return (
        <FormCard
            title="邮箱"
            description="用于登录、找回密码与安全验证。"
            action={
                editing ? undefined : (
                    <EditButton
                        icon={<Pencil className="h-3 w-3" />}
                        label={profile.email ? "修改" : "绑定"}
                        onClick={enterEdit}
                    />
                )
            }
            footer={
                editing ? (
                    <>
                        <CancelButton onClick={() => setEditing(false)} disabled={verifying}>
                            取消
                        </CancelButton>
                        <PrimaryButton
                            icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                            loading={verifying}
                            onClick={verify}
                        >
                            验证并绑定
                        </PrimaryButton>
                    </>
                ) : undefined
            }
        >
            {editing ? (
                <div className="flex flex-col gap-3 px-5 py-4">
                    <input
                        className="field"
                        value={emailVal}
                        onChange={(e) => setEmailVal(e.target.value)}
                        placeholder="your@email.com"
                    />
                    <div className="flex gap-2">
                        <input
                            className="field"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="6 位验证码"
                        />
                        <button
                            type="button"
                            onClick={sendCode}
                            disabled={sending || cooldown > 0 || !emailVal.trim()}
                            className="inline-flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-[12px] text-secondary hover:bg-border-subtle disabled:opacity-40"
                        >
                            {cooldown > 0 ? `${cooldown}s` : sending ? "发送中…" : "发送验证码"}
                        </button>
                    </div>
                    <CaptchaField key={captchaKey} onChange={setCaptcha} />
                </div>
            ) : (
                <div className="flex items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                        {profile.email ? (
                            <span className="truncate text-[13px] text-foreground">
                                {profile.email}
                            </span>
                        ) : (
                            <span className="text-[13px] text-tertiary">未绑定</span>
                        )}
                    </div>
                    {profile.email && (
                        <>
                            <Tag tone={profile.email_verified ? "ok" : "warn"}>
                                {profile.email_verified ? "已验证" : "未验证"}
                            </Tag>
                            <button
                                type="button"
                                onClick={unbind}
                                className="text-[12px] text-danger hover:underline"
                            >
                                解绑
                            </button>
                        </>
                    )}
                </div>
            )}
        </FormCard>
    );
}
