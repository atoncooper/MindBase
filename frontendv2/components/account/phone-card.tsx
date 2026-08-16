"use client";

import { useEffect, useState } from "react";
import { Check, Pencil } from "lucide-react";
import { authApi, userApi, type AuthFeatures, type CaptchaValue, type ProfileData } from "@/lib/api";
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

export function PhoneCard({ profile, onReload, onToast }: Props) {
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState("");
    const [code, setCode] = useState("");
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
        setVal(profile.phone ?? "");
        setCode("");
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

    async function sendCode() {
        if (!val.trim() || cooldown > 0) return;
        setSending(true);
        try {
            await authApi.phoneSendCode({
                phone: val.trim(),
                purpose: "bind",
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
        setSaving(true);
        try {
            if (smsEnabled) {
                await userApi.verifyPhone({ phone: val.trim(), code: code.trim() });
                onToast("手机号已验证并绑定", "success");
            } else {
                // SMS 未配置：退回直接绑定（标记未验证）
                await userApi.bindPhone({ phone: val.trim() });
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

    async function unbind() {
        try {
            await userApi.unbindPhone();
            onToast("手机号已解绑", "success");
            onReload();
        } catch (e) {
            onToast(e instanceof Error ? e.message : "解绑失败", "error");
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
                        <CancelButton onClick={() => setEditing(false)} disabled={saving}>
                            取消
                        </CancelButton>
                        <PrimaryButton
                            icon={<Check className="mr-1.5 h-3.5 w-3.5" />}
                            loading={saving}
                            onClick={save}
                        >
                            {smsEnabled ? "验证并绑定" : "保存"}
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
                    />
                    {smsEnabled ? (
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
                            短信服务未配置，当前仅支持直接绑定（标记为未验证）。
                        </p>
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-3 px-5 py-3.5">
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
