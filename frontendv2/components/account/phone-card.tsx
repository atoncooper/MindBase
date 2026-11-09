"use client";

import { useEffect, useState } from "react";
import { Check, Pencil, Smartphone } from "lucide-react";
import { authApi, userApi, type AuthFeatures, type CaptchaValue, type ProfileData, type SecurityOverview } from "@/lib/api";
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
    security: SecurityOverview;
    onReload: () => void;
    onToast: (msg: string, type: "success" | "error") => void;
}

export function PhoneCard({ profile, security, onReload, onToast }: Props) {
    const [editing, setEditing] = useState(false);
    const [unbinding, setUnbinding] = useState(false);
    const [val, setVal] = useState("");
    const [code, setCode] = useState("");
    // 已设置密码的账号换绑/绑定手机号需要 current_password 二次验证
    const [currentPassword, setCurrentPassword] = useState("");
    const [sending, setSending] = useState(false);
    const [saving, setSaving] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [features, setFeatures] = useState<AuthFeatures | null>(null);

    // Captcha gates the send-code request; bumped after every send attempt
    // (each one consumes the captcha server-side).
    const [captcha, setCaptcha] = useState<CaptchaValue>({ captcha_id: "", captcha_code: "" });
    const [captchaKey, setCaptchaKey] = useState(0);

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
        return () => clearInterval(t);
    }, [cooldown]);

    async function enterEdit() {
        setUnbinding(false);
        setVal(profile.phone ?? "");
        setCode("");
        setCurrentPassword("");
        setCooldown(0);
        setEditing(true);
        if (features === null) {
            try {
                setFeatures(await authApi.getFeatures());
            } catch {
                setFeatures({ email_register_enabled: false, sms_enabled: false });
            }
        }
    }

    const smsEnabled = features?.sms_enabled === true;
    // 未验证的手机号不能作为解绑验证因子；此时退回密码 step-up。
    const canUseSmsUnbind = smsEnabled && profile.phone_verified;

    async function sendCode() {
        if (!val.trim() || cooldown > 0) return;
        setSending(true);
        try {
            await authApi.phoneSendCode({
                phone: val.trim(),
                purpose: unbinding ? "unbind" : "bind",
                captcha_id: captcha.captcha_id,
                captcha_code: captcha.captcha_code,
            });
            setCooldown(60);
            onToast("短信验证码已发送", "success");
        } catch (e) {
            onToast(e instanceof Error ? e.message : "发送失败", "error");
        } finally {
            setSending(false);
            // The captcha was consumed regardless of outcome.
            setCaptchaKey((k) => k + 1);
        }
    }

    async function save() {
        if (!val.trim()) {
            onToast("请输入手机号", "error");
            return;
        }
        if (smsEnabled && !code.trim()) {
            onToast("请输入短信验证码", "error");
            return;
        }
        if (security.has_password && !currentPassword.trim()) {
            onToast("请输入当前密码以完成安全验证", "error");
            return;
        }
        setSaving(true);
        try {
            const stepUp = security.has_password ? currentPassword.trim() : undefined;
            if (smsEnabled) {
                await userApi.verifyPhone({
                    phone: val.trim(),
                    code: code.trim(),
                    current_password: stepUp,
                });
                onToast("手机号已验证并绑定", "success");
            } else {
                // SMS 未配置：退回直接绑定（标记未验证）
                await userApi.bindPhone({ phone: val.trim(), current_password: stepUp });
                onToast("手机号已绑定（短信服务未配置，未验证）", "success");
            }
            setEditing(false);
            onReload();
        } catch (e) {
            onToast(e instanceof Error ? e.message : "绑定失败", "error");
        } finally {
            setSaving(false);
        }
    }

    async function enterUnbind() {
        setUnbinding(true);
        setEditing(true);
        setVal(profile.phone ?? "");
        setCode("");
        setCurrentPassword("");
        setCooldown(0);
        if (features === null) {
            try {
                setFeatures(await authApi.getFeatures());
            } catch {
                setFeatures({ email_register_enabled: false, sms_enabled: false });
            }
        }
    }

    async function confirmUnbind() {
        if (canUseSmsUnbind && !code.trim()) {
            onToast("请输入短信验证码", "error");
            return;
        }
        if (!canUseSmsUnbind && security.has_password && !currentPassword.trim()) {
            onToast("请输入当前密码", "error");
            return;
        }
        setSaving(true);
        try {
            if (canUseSmsUnbind) {
                await userApi.unbindPhone({ code: code.trim() });
            } else {
                await userApi.unbindPhone({ current_password: currentPassword.trim() });
            }
            onToast("手机号已解绑", "success");
            setEditing(false);
            setUnbinding(false);
            onReload();
        } catch (e) {
            onToast(e instanceof Error ? e.message : "解绑失败", "error");
        } finally {
            setSaving(false);
        }
    }

    return (
        <FormCard
            title="手机号"
            description="用于账号绑定与身份验证。"
            action={
                editing ? undefined : (
                    <EditButton
                        icon={<Pencil className="h-3 w-3" />}
                        label={profile.phone ? "修改" : "绑定"}
                        onClick={enterEdit}
                    />
                )
            }
            footer={
                editing ? (
                    <>
                        <CancelButton onClick={() => { setEditing(false); setUnbinding(false); }} disabled={saving}>
                            取消
                        </CancelButton>
                        <PrimaryButton
                            icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                            loading={saving}
                            onClick={unbinding ? confirmUnbind : save}
                        >
                            {unbinding ? "验证并解绑" : smsEnabled ? "验证并绑定" : "保存"}
                        </PrimaryButton>
                    </>
                ) : undefined
            }
        >
            {editing ? (
                <div className="flex flex-col gap-3 px-5 py-4">
                    <input
                        className="field"
                        value={val}
                        onChange={(e) => setVal(e.target.value.replace(/[^\d+]/g, ""))}
                        placeholder="13800138000"
                        maxLength={14}
                        disabled={unbinding}
                    />
                    {security.has_password && (!unbinding || !canUseSmsUnbind) && (
                        <input
                            className="field"
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder="当前密码（换绑需安全验证）"
                            autoComplete="current-password"
                        />
                    )}
                    {canUseSmsUnbind ? (
                        <>
                            <div className="flex gap-2">
                                <input
                                    className="field"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                                    placeholder="短信验证码"
                                    maxLength={6}
                                />
                                <button
                                    type="button"
                                    onClick={sendCode}
                                    disabled={sending || cooldown > 0 || !val.trim()}
                                    className="inline-flex h-12 shrink-0 items-center rounded-[var(--radius)] border border-border px-3 text-[12px] text-secondary transition-colors hover:bg-border-subtle disabled:opacity-40"
                                >
                                    {cooldown > 0 ? `${cooldown}s` : sending ? "发送中…" : "发送验证码"}
                                </button>
                            </div>
                            <CaptchaField key={captchaKey} onChange={setCaptcha} />
                        </>
                    ) : (
                        <p className="text-[12px] text-tertiary">
                            {unbinding
                                ? "当前手机号未验证，解绑需输入当前密码（未设置密码请先在「密码」卡设置）。"
                                : "短信服务未配置，当前仅支持直接绑定（标记为未验证）。"}
                        </p>
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-3 px-5 py-3.5">
                    <Smartphone className="h-4 w-4 shrink-0 text-secondary" />
                    <div className="min-w-0 flex-1">
                        {profile.phone ? (
                            <span className="text-[13px] text-foreground">{profile.phone}</span>
                        ) : (
                            <span className="text-[13px] text-tertiary">未绑定</span>
                        )}
                    </div>
                    {profile.phone && (
                        <>
                            <Tag tone={profile.phone_verified ? "ok" : "warn"}>
                                {profile.phone_verified ? "已验证" : "未验证"}
                            </Tag>
                            <button
                                type="button"
                                onClick={enterUnbind}
                                className="rounded px-1 py-0.5 text-[12px] text-danger transition-colors hover:bg-danger/10"
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
