"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Pencil } from "lucide-react";
import { userApi, type ProfileData, type SecurityOverview } from "@/lib/api";
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

    // 2FA code required when changing an existing password with a verified email.
    const needs2FA =
        security.has_password && !!profile.email_verified && !!profile.email;

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
        if (!profile.email || cooldown > 0) return;
        setSending(true);
        try {
            await userApi.sendEmailCode({ email: profile.email, purpose: "twofa" });
            setCooldown(60);
            onToast("验证码已发送至邮箱", "success");
        } catch (e) {
            onToast(e instanceof Error ? e.message : "发送失败", "error");
        } finally {
            setSending(false);
        }
    }

    async function save() {
        setError(null);
        if (security.has_password) {
            if (!oldPw || !newPw) {
                setError("请填写当前密码和新密码");
                return;
            }
            if (needs2FA && !code.trim()) {
                setError("请输入邮箱验证码");
                return;
            }
        } else if (!newPw) {
            setError("请输入新密码");
            return;
        }
        setSaving(true);
        try {
            if (security.has_password) {
                await userApi.changePassword({
                    old_password: oldPw,
                    new_password: newPw,
                    email_code: needs2FA ? code.trim() : undefined,
                });
            } else {
                await userApi.setPassword({ password: newPw });
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
                    {needs2FA && (
                        <>
                            <div className="flex gap-2">
                                <input
                                    className="field"
                                    value={code}
                                    onChange={(e) => {
                                        setCode(e.target.value);
                                        setError(null);
                                    }}
                                    placeholder="邮箱验证码（二次验证）"
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
                            <p className="text-[12px] text-tertiary">
                                验证码将发送至 {profile.email}
                            </p>
                        </>
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
