"use client";

import { useState } from "react";
import {
    AtSign,
    BadgeCheck,
    Cake,
    CalendarDays,
    Check,
    FileText,
    Globe,
    ImagePlus,
    Languages,
    Loader2,
    Mail,
    MapPin,
    Pencil,
    ShieldCheck,
    SlidersHorizontal,
    UserRound,
} from "lucide-react";
import { Select } from "@/components/ui/select";
import { userApi, type PayMembership, type ProfileData } from "@/lib/api";
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
    membership?: PayMembership | null;
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

export function ProfileCard({ profile, membership, onUpdated, onToast }: Props) {
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
            title="公开资料"
            description="头像、昵称与简介会展示在个人中心与公开页面；其他字段用于个性化。"
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
                <ProfileView profile={profile} membership={membership} onEdit={enterEdit} />
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

function displayDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value.length === 10 ? value + "T00:00:00" : value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function ProfileView({
    profile,
    membership,
    onEdit,
}: {
    profile: ProfileData;
    membership?: PayMembership | null;
    onEdit: () => void;
}) {
    const name = profile.nickname?.trim() || "MindBase 用户";
    const initial = name.slice(0, 1).toUpperCase();
    const fields = [
        profile.nickname,
        profile.avatar,
        profile.bio,
        profile.birthday,
        profile.gender,
        profile.location,
        profile.timezone,
        profile.language,
    ];
    const filled = fields.filter((v) => Boolean(v && String(v).trim())).length;
    const percent = Math.round((filled / fields.length) * 100);
    const joined = displayDate(profile.created_at);
    const birthday = displayDate(profile.birthday);
    const tier = membership?.active ? (membership.tier ?? "").toUpperCase() : "";
    const tierLabel = tier === "PROMAX" ? "ProMax" : tier;
    const language = profile.language ? LANG_LABELS[profile.language] ?? profile.language : null;
    const gender = profile.gender ? GENDER_LABELS[profile.gender] ?? profile.gender : null;

    return (
        <div className="space-y-4 p-5">
            <div className="relative overflow-hidden rounded-2xl border border-border-subtle bg-[#fbfcfe] p-5 sm:p-6">
                <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-accent/5 blur-3xl" />
                <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
                    <div className="shrink-0">
                        {profile.avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={profile.avatar}
                                alt={name}
                                className="h-20 w-20 rounded-full object-cover shadow-sm ring-4 ring-white sm:h-24 sm:w-24"
                            />
                        ) : (
                            <span className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[#e8f0fe] to-[#fef7e0] text-2xl font-medium text-[#3c4043] shadow-sm ring-4 ring-white sm:h-24 sm:w-24">
                                {initial}
                            </span>
                        )}
                    </div>

                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                            <h3 className="truncate text-[22px] font-medium leading-8 text-foreground">
                                {name}
                            </h3>
                            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-secondary">
                                UID {profile.uid}
                            </span>
                            {tier && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-300/60">
                                    <ShieldCheck className="h-3 w-3" />
                                    {tierLabel} 会员
                                </span>
                            )}
                            {profile.email_verified && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                                    <BadgeCheck className="h-3 w-3" />
                                    已验证
                                </span>
                            )}
                        </div>
                        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-secondary">
                            {profile.bio || "还没有简介。添加一句介绍，让个人主页更容易被记住。"}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-tertiary">
                            {profile.email && (
                                <span className="inline-flex items-center gap-1.5">
                                    <Mail className="h-3.5 w-3.5" />
                                    {profile.email}
                                </span>
                            )}
                            {joined && (
                                <span className="inline-flex items-center gap-1.5">
                                    <CalendarDays className="h-3.5 w-3.5" />
                                    加入于 {joined}
                                </span>
                            )}
                            <span className="inline-flex items-center gap-1.5">
                                <ShieldCheck className="h-3.5 w-3.5" />
                                {profile.status === "active" || !profile.status ? "账户状态正常" : profile.status}
                            </span>
                        </div>
                    </div>

                    <div className="w-full shrink-0 rounded-xl border border-border-subtle bg-surface/80 p-3 sm:w-44">
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="text-secondary">资料完整度</span>
                            <span className="font-medium text-foreground">{percent}%</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border-subtle">
                            <div
                                className="h-full rounded-full bg-accent transition-[width]"
                                style={{ width: percent + "%" }}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={onEdit}
                            className="mt-2.5 text-[11px] font-medium text-accent transition-colors hover:text-accent-hover"
                        >
                            {percent >= 100 ? "修改资料" : "继续完善 →"}
                        </button>
                    </div>
                </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
                <InfoCard icon={<UserRound className="h-4 w-4" />} title="公开资料">
                    <InfoRow icon={<FileText className="h-3.5 w-3.5" />} label="简介" value={profile.bio} />
                    <InfoRow icon={<Cake className="h-3.5 w-3.5" />} label="生日" value={birthday} />
                    <InfoRow icon={<UserRound className="h-3.5 w-3.5" />} label="性别" value={gender} />
                    <InfoRow icon={<MapPin className="h-3.5 w-3.5" />} label="地区" value={profile.location} />
                </InfoCard>

                <InfoCard icon={<SlidersHorizontal className="h-4 w-4" />} title="偏好设置">
                    <InfoRow icon={<Globe className="h-3.5 w-3.5" />} label="时区" value={profile.timezone} />
                    <InfoRow icon={<Languages className="h-3.5 w-3.5" />} label="语言" value={language} />
                    <InfoRow icon={<CalendarDays className="h-3.5 w-3.5" />} label="加入" value={joined} />
                </InfoCard>

                <InfoCard icon={<AtSign className="h-4 w-4" />} title="账户">
                    <InfoRow icon={<AtSign className="h-3.5 w-3.5" />} label="UID" value={String(profile.uid)} />
                    <InfoRow icon={<Mail className="h-3.5 w-3.5" />} label="邮箱" value={profile.email} />
                    <InfoRow
                        icon={<ShieldCheck className="h-3.5 w-3.5" />}
                        label="状态"
                        value={profile.status === "active" || !profile.status ? "正常" : profile.status}
                    />
                </InfoCard>
            </div>
        </div>
    );
}

function InfoCard({
    icon,
    title,
    children,
}: {
    icon: React.ReactNode;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <section className="rounded-xl border border-border-subtle bg-surface p-4">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-foreground">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft text-accent">
                    {icon}
                </span>
                {title}
            </div>
            <dl className="space-y-1.5">{children}</dl>
        </section>
    );
}

function InfoRow({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string | null | undefined;
}) {
    return (
        <div className="flex items-start gap-2 rounded-lg px-1.5 py-1.5">
            <span className="mt-0.5 text-tertiary">{icon}</span>
            <dt className="w-14 shrink-0 text-[12px] text-secondary">{label}</dt>
            <dd className="min-w-0 flex-1 text-[12px] leading-relaxed text-foreground">
                {value || <span className="text-tertiary">未设置</span>}
            </dd>
        </div>
    );
}
