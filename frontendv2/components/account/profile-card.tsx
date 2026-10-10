"use client";

import { useState } from "react";
import { Check, ImagePlus, Loader2, Pencil } from "lucide-react";
import { Select } from "@/components/ui/select";
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
    const [uploading, setUploading] = useState(false);
    // 本地预览：优先刚上传/已有的 form.avatar，回退到当前 profile 头像。
    const preview = (editing ? form.avatar : "") || profile.avatar || "";

    async function onAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = ""; // 允许重选同一文件
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            onToast("头像不能超过 2MB", "error");
            return;
        }
        setUploading(true);
        try {
            const { url } = await userApi.uploadAvatar(file);
            setForm((prev) => ({ ...prev, avatar: url }));
            onToast("头像已上传，保存资料后生效", "success");
        } catch (err) {
            onToast(err instanceof Error ? err.message : "头像上传失败", "error");
        } finally {
            setUploading(false);
        }
    }

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
                    <Field label="头像">
                        <div className="flex items-center gap-3">
                            {preview ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={preview}
                                    alt=""
                                    className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-border-subtle"
                                />
                            ) : (
                                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-border-subtle text-tertiary">
                                    <ImagePlus className="h-4 w-4" />
                                </span>
                            )}
                            <label className="btn-pill btn-ghost inline-flex h-8 cursor-pointer items-center gap-1.5 px-4 text-[12px]">
                                {uploading ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <ImagePlus className="h-3.5 w-3.5" />
                                )}
                                {uploading ? "上传中…" : "选择图片"}
                                <input
                                    type="file"
                                    accept="image/png,image/jpeg,image/webp"
                                    className="hidden"
                                    disabled={uploading}
                                    onChange={onAvatarPick}
                                />
                            </label>
                            <span className="min-w-0 truncate text-[12px] text-tertiary">
                                PNG / JPG / WebP，≤ 2MB
                            </span>
                        </div>
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
                        <Select
                            value={form.gender}
                            onChange={(v) => set("gender", v)}
                            placeholder="未设置"
                            options={[
                                { value: "male", label: "男" },
                                { value: "female", label: "女" },
                                { value: "other", label: "其他" },
                            ]}
                        />
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
                        <Select
                            value={form.language}
                            onChange={(v) => set("language", v)}
                            placeholder="未设置"
                            options={[
                                { value: "zh", label: "中文" },
                                { value: "en", label: "English" },
                            ]}
                        />
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
