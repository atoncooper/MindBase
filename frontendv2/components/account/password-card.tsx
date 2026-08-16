"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Pencil } from "lucide-react";
import { userApi, authApi, type CaptchaValue, type ProfileData, type SecurityOverview } from "@/lib/api";
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

export function PasswordCard({ profile, security, onReload, onToast }: Props) {
    const [editing, setEditing] = useState(false);
    const [oldPw, setOldPw] = useState("");
    const [newPw, setNewPw] = useState("");
    const [code, setCode] = useState("");
    const [show, setShow] = useState(false);
    const [sending, setSending] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Captcha for the 2FA send-code request. Bumping captchaKey remounts
    // CaptchaField with a fresh image (each send consumes the captcha).
    const [captcha, setCaptcha] = useState<CaptchaValue>({ captcha_id: "", captcha_code: "" });
    const [captchaKey, setCaptchaKey] = useState(0);

    // 二次验证（与后端对齐）：
    //   修改密码 —— 有已验证邮箱时要求邮箱验证码；
    //   首次设置 —— 没有旧密码这一知识因子，同样强制验证码：
    //               优先邮箱，仅有已验证手机时用短信；都没有则先绑定。
    const isChange = security.has_password;
    const hasVerifiedEmail = !!profile.email_verified && !!profile.email;
    const hasVerifiedPhone = !!profile.phone_verified && !!profile.phone;
    const needsEmailCode = hasVerifiedEmail;
    const needsSmsCode = !isChange && !hasVerifiedEmail && hasVerifiedPhone;
    const needsCode = needsEmailCode || needsSmsCode;
    const noVerifiedContact = !isChange && !hasVerifiedEmail && !hasVerifiedPhone;

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
        return () => clearInterval(t);
    }, [cooldown]);

    function reset() {
        setOldPw("");
        setNewPw("");
        setCode("");
        setCooldown(0);
        setError(null);
        setShow(false);
        setEditing(false);
    }

    function enterEdit() {
        setOldPw("");
        setNewPw("");
        setCode("");
        setCooldown(0);
        setError(null);
        setEditing(true);
    }

    async function sendCode() {
        if (cooldown > 0) return;
        if (needsEmailCode && !profile.email) return;
        if (needsSmsCode && !profile.phone) return;
        setSending(true);
        try {
            if (needsEmailCode) {
                await userApi.sendEmailCode({
                    email: profile.email!,
                    purpose: "twofa",
                    captcha_id: captcha.captcha_id,
                    captcha_code: captcha.captcha_code,
                });
                onToast("验证码已发送至邮箱", "success");
            } else {
                await authApi.phoneSendCode({
                    phone: profile.phone!,
                    purpose: "twofa",
                    captcha_id: captcha.captcha_id,
                    captcha_code: captcha.captcha_code,
                });
                onToast("短信验证码已发送", "success");
            }
            setCooldown(60);
        } catch (e) {
            onToast(e instanceof Error ? e.message : "发送失败", "error");
        } finally {
            setSending(false);
            // The captcha was consumed regardless of outcome.
            setCaptchaKey((k) => k + 1);
        }
    }

    async function save() {
        setError(null);
        if (security.has_password) {
            if (!oldPw || !newPw) {
                setError("请填写当前密码和新密码");
                return;
            }
            if (needsEmailCode && !code.trim()) {
                setError("请输入邮箱验证码");
                return;
            }
        } else if (!newPw) {
            setError("请输入新密码");
            return;
        }
        if (noVerifiedContact) {
            setError("请先绑定并验证邮箱或手机号，再设置密码");
            return;
        }
        if (!security.has_password && needsCode && !code.trim()) {
            setError(needsEmailCode ? "请输入邮箱验证码" : "请输入短信验证码");
            return;
        }
        setSaving(true);
        try {
            if (security.has_password) {
                await userApi.changePassword({
                    old_password: oldPw,
                    new_password: newPw,
                    email_code: needsEmailCode ? code.trim() : undefined,
                });
            } else {
                await userApi.setPassword({
                    password: newPw,
                    email_code: needsEmailCode ? code.trim() : undefined,
                    sms_code: needsSmsCode ? code.trim() : undefined,
                });
            }
            reset();
            onToast(security.has_password ? "密码已修改" : "密码已设置", "success");
            onReload();
        } catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <FormCard
            title="密码"
            description="用于账号登录。修改密码时需通过邮箱二次验证。"
            action={
                editing ? undefined : (
                    <EditButton
                        icon={<Pencil className="h-3 w-3" />}
                        label={security.has_password ? "修改" : "设置"}
                        onClick={enterEdit}
                    />
                )
            }
            footer={
                editing ? (
                    <>
                        <button
                            type="button"
                            onClick={() => setShow((p) => !p)}
                            className="mr-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-secondary hover:bg-border-subtle"
                        >
                            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            {show ? "隐藏" : "显示"}
                        </button>
                        <CancelButton onClick={reset} disabled={saving}>
                            取消
                        </CancelButton>
                        <PrimaryButton
                            icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                            loading={saving}
                            onClick={save}
                        >
                            保存
                        </PrimaryButton>
                    </>
                ) : undefined
            }
        >
            {editing ? (
                <div className="flex flex-col gap-3 px-5 py-4">
                    {security.has_password && (
                        <input
                            className="field"
                            type={show ? "text" : "password"}
                            value={oldPw}
                            onChange={(e) => {
                                setOldPw(e.target.value);
                                setError(null);
                            }}
                            placeholder="当前密码"
                        />
                    )}
                    <input
                        className="field"
                        type={show ? "text" : "password"}
                        value={newPw}
                        onChange={(e) => {
                            setNewPw(e.target.value);
                            setError(null);
                        }}
                        placeholder="新密码（8 位以上，含字母和数字）"
                    />
                    {needsCode && (
                        <>
                            <div className="flex gap-2">
                                <input
                                    className="field"
                                    value={code}
                                    onChange={(e) => {
                                        setCode(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder={needsEmailCode ? "邮箱验证码（二次验证）" : "短信验证码（二次验证）"}
                                />
                                <button
                                    type="button"
                                    onClick={sendCode}
                                    disabled={sending || cooldown > 0}
                                    className="inline-flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-[12px] text-secondary hover:bg-border-subtle disabled:opacity-40"
                                >
                                    {cooldown > 0 ? `${cooldown}s` : sending ? "发送中…" : "发送验证码"}
                                </button>
                            </div>
                            <CaptchaField key={captchaKey} onChange={setCaptcha} />
                            <p className="text-[12px] text-tertiary">
                                验证码将发送至 {needsEmailCode ? profile.email : profile.phone}
                            </p>
                        </>
                    )}
                    {noVerifiedContact && (
                        <p className="rounded-md border border-border bg-border-subtle px-3 py-2 text-[12px] text-secondary">
                            账号尚未绑定任何已验证联系方式，无法设置密码——请先在上方绑定并验证邮箱或手机号。
                        </p>
                    )}
                    {error && (
                        <div className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                            {error}
                        </div>
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1 text-[13px] text-foreground">
                        {security.has_password ? "已设置" : "未设置"}
                    </div>
                    <Tag tone={security.has_password ? "ok" : "warn"}>
                        {security.has_password ? "已设置" : "未设置"}
                    </Tag>
                </div>
            )}
        </FormCard>
    );
}
