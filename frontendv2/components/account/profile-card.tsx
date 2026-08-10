"use client";

import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { userApi, type ProfileData } from "@/lib/api";
import {
    FormCard,
    EditButton,
    CancelButton,
    PrimaryButton,
} from "./form-card";

const GENDER_LABELS: Record<string, string> = {
    male: "男",
    female: "女",
    other: "其他",
};
const LANG_LABELS: Record<string, string> = { zh: "中文", en: "English" };

interface Props {
    profile: ProfileData;
    onUpdated: (p: ProfileData) => void;
    onToast: (msg: string, type: "success" | "error") => void;
}

interface FormState {
    nickname: string;
    avatar: string;
    bio: string;
    birthday: string;
    gender: string;
    location: string;
    timezone: string;
    language: string;
}

function toForm(p: ProfileData): FormState {
    return {
        nickname: p.nickname ?? "",
        avatar: p.avatar ?? "",
        bio: p.bio ?? "",
        birthday: p.birthday ?? "",
        gender: p.gender ?? "",
        location: p.location ?? "",
        timezone: p.timezone ?? "",
        language: p.language ?? "",
    };
}

export function ProfileCard({ profile, onUpdated, onToast }: Props) {
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState<FormState>(() => toForm(profile));
    const [saving, setSaving] = useState(false);

    function enterEdit() {
        setForm(toForm(profile));
        setEditing(true);
    }

    function set<K extends keyof FormState>(key: K, v: string) {
        setForm((prev) => ({ ...prev, [key]: v }));
    }

    async function save() {
        setSaving(true);
        try {
            const data: Record<string, string> = {};
            for (const [k, v] of Object.entries(form)) {
                if (v.trim()) data[k] = v.trim();
            }
            const updated = await userApi.updateProfile(data);
            onUpdated(updated);
            setEditing(false);
            onToast("个人资料已更新", "success");
        } catch (e) {
            onToast(e instanceof Error ? e.message : "保存失败", "error");
        } finally {
            setSaving(false);
        }
    }

    return (
        <FormCard
            title="个人资料"
            description="管理你的公开身份信息。"
            action={
                editing ? undefined : (
                    <EditButton
                        icon={<Pencil className="h-3 w-3" />}
                        label="编辑"
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
                <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
                    <Field label="昵称">
                        <input
                            className="field"
                            value={form.nickname}
                            onChange={(e) => set("nickname", e.target.value)}
                            placeholder="未设置"
                            maxLength={40}
                        />
                    </Field>
                    <Field label="头像 URL">
                        <input
                            className="field"
                            value={form.avatar}
                            onChange={(e) => set("avatar", e.target.value)}
                            placeholder="https://…"
                        />
                    </Field>
                    <Field label="简介">
                        <input
                            className="field"
                            value={form.bio}
                            onChange={(e) => set("bio", e.target.value)}
                            placeholder="一句话介绍"
                            maxLength={200}
                        />
                    </Field>
                    <Field label="生日">
                        <input
                            type="date"
                            className="field"
                            value={form.birthday}
                            onChange={(e) => set("birthday", e.target.value)}
                        />
                    </Field>
                    <Field label="性别">
                        <select
                            className="field"
                            value={form.gender}
                            onChange={(e) => set("gender", e.target.value)}
                        >
                            <option value="">未设置</option>
                            <option value="male">男</option>
                            <option value="female">女</option>
                            <option value="other">其他</option>
                        </select>
                    </Field>
                    <Field label="地区">
                        <input
                            className="field"
                            value={form.location}
                            onChange={(e) => set("location", e.target.value)}
                            placeholder="如 上海"
                        />
                    </Field>
                    <Field label="时区">
                        <input
                            className="field"
                            value={form.timezone}
                            onChange={(e) => set("timezone", e.target.value)}
                            placeholder="Asia/Shanghai"
                        />
                    </Field>
                    <Field label="语言">
                        <select
                            className="field"
                            value={form.language}
                            onChange={(e) => set("language", e.target.value)}
                        >
                            <option value="">未设置</option>
                            <option value="zh">中文</option>
                            <option value="en">English</option>
                        </select>
                    </Field>
                </div>
            ) : (
                <dl className="divide-y divide-border-subtle">
                    <ViewRow label="昵称" value={profile.nickname} />
                    <ViewRow label="简介" value={profile.bio} />
                    <ViewRow label="生日" value={profile.birthday} />
                    <ViewRow
                        label="性别"
                        value={
                            profile.gender ? GENDER_LABELS[profile.gender] ?? profile.gender : null
                        }
                    />
                    <ViewRow label="地区" value={profile.location} />
                    <ViewRow label="时区" value={profile.timezone} />
                    <ViewRow
                        label="语言"
                        value={
                            profile.language
                                ? LANG_LABELS[profile.language] ?? profile.language
                                : null
                        }
                    />
                </dl>
            )}
        </FormCard>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-secondary">{label}</span>
            {children}
        </label>
    );
}

function ViewRow({ label, value }: { label: string; value: string | null | undefined }) {
    return (
        <div className="flex items-baseline gap-4 px-5 py-2.5">
            <dt className="w-20 shrink-0 text-[12px] font-medium text-secondary">{label}</dt>
            <dd className="min-w-0 flex-1 text-[13px] text-foreground">
                {value || <span className="text-tertiary">未设置</span>}
            </dd>
        </div>
    );
}
