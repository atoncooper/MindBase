"use client";

/**
 * 个人中心共享 UI 原语（Google Account / Workspace Admin 风格）。
 *
 * 视觉 token 由 globals.css 的 .g-account 作用域提供：浅灰 #f8f9fa 页面底、
 * 白色 #dadce0 描边卡片、12px 圆角、Google 蓝 #0b57d0、正文 #202124。
 * 这里只做无状态展示；数据与交互由 account-view / account-sections 负责。
 */
import Link from "next/link";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const CHIP_TONES: Record<Tone, string> = {
    neutral: "bg-[#f1f3f4] text-[#5f6368]",
    info: "bg-accent-soft text-accent",
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
};

/** 小号状态胶囊（M3 tonal chip）。 */
export function StatusChip({
    tone = "neutral",
    children,
    className,
}: {
    tone?: Tone;
    children: ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium leading-none",
                CHIP_TONES[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}

/** 白色描边卡片。 */
export function AccountCard({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <section className={cn("rounded-[12px] border border-border bg-surface", className)}>
            {children}
        </section>
    );
}

/** 卡片头部：圆形淡蓝图标 + 标题 + 说明 + 右侧操作。 */
export function CardHeader({
    icon,
    title,
    description,
    action,
    className,
}: {
    icon?: ReactNode;
    title: string;
    description?: string;
    action?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex items-start justify-between gap-4 px-5 pb-3 pt-5", className)}>
            <div className="flex min-w-0 items-start gap-3">
                {icon && (
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                        {icon}
                    </span>
                )}
                <div className="min-w-0">
                    <h2 className="text-[15px] font-medium leading-6 text-foreground">{title}</h2>
                    {description && (
                        <p className="mt-0.5 text-[12px] leading-relaxed text-secondary">
                            {description}
                        </p>
                    )}
                </div>
            </div>
            {action && <div className="shrink-0 pt-0.5">{action}</div>}
        </div>
    );
}

const BUTTON_BASE =
    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-4 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const BUTTON_VARIANTS = {
    filled: "bg-accent text-white shadow-[0_1px_2px_rgba(60,64,67,0.28)] hover:bg-accent-hover",
    outlined: "border border-border bg-surface text-accent hover:bg-[#f8f9fa]",
    text: "px-2.5 text-accent hover:bg-[#f1f3f4]",
    danger: "px-2.5 text-danger hover:bg-danger/5",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

/** Google 风格按钮：填充 / 描边 / 文本 / 危险文本。 */
export function GoogleButton({
    variant = "filled",
    className,
    type = "button",
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
    return (
        <button
            type={type}
            className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
            {...props}
        >
            {children}
        </button>
    );
}

/** 与 GoogleButton 同视觉的站内链接按钮。 */
export function GoogleLinkButton({
    href,
    variant = "outlined",
    className,
    children,
}: {
    href: string;
    variant?: ButtonVariant;
    className?: string;
    children: ReactNode;
}) {
    return (
        <Link href={href} className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}>
            {children}
        </Link>
    );
}

/** 圆形图标按钮（刷新、更多等）。 */
export function GoogleIconButton({
    className,
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            type="button"
            className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-[#f1f3f4] disabled:opacity-40",
                className,
            )}
            {...props}
        >
            {children}
        </button>
    );
}

/** 细进度条（M3 linear progress）。 */
export function ProgressBar({
    value,
    tone = "info",
    className,
}: {
    value: number;
    tone?: "info" | "success" | "warning" | "danger";
    className?: string;
}) {
    const width = Math.max(0, Math.min(100, Math.round(value)));
    const color = {
        info: "bg-accent",
        success: "bg-success",
        warning: "bg-warning",
        danger: "bg-danger",
    }[tone];
    return (
        <div
            className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[#e8eaed]", className)}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={width}
        >
            <div
                className={cn("h-full rounded-full transition-all duration-300", color)}
                style={{ width: `${width}%` }}
            />
        </div>
    );
}

/** 头像：加载失败或未设置时回退为首字母。 */
export function AccountAvatar({
    url,
    name,
    uid,
    size = 40,
    className,
}: {
    url: string | null;
    name: string | null;
    uid: number;
    size?: number;
    className?: string;
}) {
    const [failed, setFailed] = useState(false);
    const initial = (name?.trim()?.[0] || String(uid).slice(0, 1) || "U").toUpperCase();

    if (url && !failed) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={url}
                alt=""
                onError={() => setFailed(true)}
                className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", className)}
                style={{ width: size, height: size }}
            />
        );
    }
    return (
        <span
            aria-hidden="true"
            className={cn(
                "grid shrink-0 place-items-center rounded-full bg-accent font-medium text-white",
                className,
            )}
            style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
        >
            {initial}
        </span>
    );
}

/** 键值对（用于 `<dl>` 网格）。 */
export function MetaItem({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-[11px] text-tertiary">{label}</dt>
            <dd className="mt-0.5 truncate text-[13px] font-medium text-foreground">{value}</dd>
        </div>
    );
}
