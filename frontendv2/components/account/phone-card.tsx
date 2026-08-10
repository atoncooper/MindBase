"use client";

import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { userApi, type ProfileData } from "@/lib/api";
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
    const [saving, setSaving] = useState(false);

    function enterEdit() {
        setVal(profile.phone ?? "");
        setEditing(true);
    }

    async function save() {
        if (!val.trim()) {
            onToast("请输入手机号", "error");
            return;
        }
        setSaving(true);
        try {
            await userApi.bindPhone({ phone: val.trim() });
            setEditing(false);
            onToast("手机号已绑定", "success");
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
                            保存
                        </PrimaryButton>
                    </>
                ) : undefined
            }
        >
            {editing ? (
                <div className="px-5 py-4">
                    <input
                        className="field"
                        value={val}
                        onChange={(e) => setVal(e.target.value)}
                        placeholder="13800138000"
                    />
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
