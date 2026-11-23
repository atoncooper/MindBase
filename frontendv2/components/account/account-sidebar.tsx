"use client";

/**
 * 个人中心左侧导航（Google Workspace Admin 式）。
 *
 * 桌面端为 264px 白色卡片侧栏：账户摘要 + 三组导航 + 快捷入口 + 退出登录；
 * 移动端折叠为横向可滚动的分组胶囊，页面不因侧栏过长而失去内容入口。
 */
import Link from "next/link";
import { ArrowUpRight, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PayMembership, ProfileData, SecurityOverview } from "@/lib/api";
import { NAV_GROUPS, QUICK_LINKS, type NavItem, type SectionKey } from "./account-config";
import { AccountAvatar } from "./account-ui";
import { formatDate, membershipTier } from "./account-utils";

interface AccountSidebarProps {
    profile: ProfileData;
    security: SecurityOverview | null;
    membership: PayMembership | null;
    active: SectionKey;
    onSelect: (key: SectionKey) => void;
    onLogout: () => void;
}

/** 导航项右侧状态点：已验证/已设置为绿，已绑定未验证为琥珀，未绑定不显示。 */
function statusDot(
    key: SectionKey,
    profile: ProfileData,
    security: SecurityOverview | null,
): string | null {
    switch (key) {
        case "email":
            return profile.email ? (profile.email_verified ? "bg-success" : "bg-warning") : null;
        case "phone":
            return profile.phone ? (profile.phone_verified ? "bg-success" : "bg-warning") : null;
        case "password":
            return security?.has_password ? "bg-success" : null;
        case "bilibili":
            if (!security) return null;
            return security.bilibili.valid
                ? "bg-success"
                : security.bilibili.bound
                  ? "bg-warning"
                  : null;
        default:
            return null;
    }
}

function SidebarNavItem({
    item,
    active,
    dot,
    badge,
    onClick,
}: {
    item: NavItem;
    active: boolean;
    dot: string | null;
    badge?: string;
    onClick: () => void;
}) {
    const Icon = item.icon;
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-left text-[13px] transition-colors lg:w-full",
                active
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-foreground hover:bg-[#f1f3f4]",
            )}
        >
            <Icon
                className={cn(
                    "h-[18px] w-[18px] shrink-0",
                    active ? "text-accent" : "text-secondary",
                )}
            />
            <span className="whitespace-nowrap">{item.label}</span>
            {badge && (
                <span className="ml-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-warning lg:ml-auto">
                    {badge}
                </span>
            )}
            {dot && (
                <span
                    className={cn("ml-1 h-1.5 w-1.5 shrink-0 rounded-full lg:ml-auto", dot)}
                    aria-hidden="true"
                />
            )}
        </button>
    );
}

export function AccountSidebar({
    profile,
    security,
    membership,
    active,
    onSelect,
    onLogout,
}: AccountSidebarProps) {
    const tier = membershipTier(membership);
    const paid = tier === "VIP" || tier === "SVIP" || tier === "PROMAX";

    return (
        <aside className="no-scrollbar min-w-0 self-start lg:sticky lg:top-[80px] lg:w-[264px] lg:shrink-0 lg:max-h-[calc(100dvh-96px)] lg:overflow-y-auto">
            <div className="overflow-hidden rounded-[12px] border border-border bg-surface">
                {/* 账户摘要 */}
                <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-4">
                    <AccountAvatar
                        key={profile.avatar ?? "fallback"}
                        url={profile.avatar}
                        name={profile.nickname}
                        uid={profile.uid}
                        size={44}
                    />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium text-foreground">
                            {profile.nickname || `用户 ${profile.uid}`}
                        </p>
                        <p className="truncate text-[12px] text-secondary">
                            {profile.email || `UID ${profile.uid}`}
                        </p>
                    </div>
                </div>

                {/* 分组导航：移动端横向滚动，桌面端纵向列表 */}
                <nav
                    className="no-scrollbar flex gap-1 overflow-x-auto p-2 lg:block lg:space-y-3 lg:overflow-visible lg:p-3"
                    aria-label="个人中心导航"
                >
                    {NAV_GROUPS.map((group, groupIndex) => (
                        <div
                            key={group.label}
                            className={cn(
                                "flex shrink-0 items-center gap-1 lg:block lg:space-y-0.5",
                                groupIndex > 0 &&
                                    "border-l border-border-subtle pl-1 lg:border-0 lg:pl-0",
                            )}
                        >
                            <p className="hidden px-2 pb-1 pt-1 text-[11px] font-medium tracking-wide text-tertiary lg:block">
                                {group.label}
                            </p>
                            {group.items.map((item) => (
                                <SidebarNavItem
                                    key={item.key}
                                    item={item}
                                    active={active === item.key}
                                    dot={statusDot(item.key, profile, security)}
                                    badge={item.key === "membership" && paid ? tier : undefined}
                                    onClick={() => onSelect(item.key)}
                                />
                            ))}
                        </div>
                    ))}
                </nav>

                {/* 快捷入口 + 退出登录 */}
                <div className="border-t border-border-subtle p-2">
                    <p className="hidden px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-tertiary lg:block">
                        快捷入口
                    </p>
                    <div className="no-scrollbar flex gap-1 overflow-x-auto lg:block lg:space-y-0.5">
                        {QUICK_LINKS.map((link) => {
                            const Icon = link.icon;
                            return (
                                <Link
                                    key={link.href}
                                    href={link.href}
                                    className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[13px] text-foreground transition-colors hover:bg-[#f1f3f4] lg:w-full"
                                >
                                    <Icon className="h-[18px] w-[18px] shrink-0 text-secondary" />
                                    <span className="whitespace-nowrap">{link.label}</span>
                                    <ArrowUpRight className="ml-1 h-3.5 w-3.5 text-tertiary lg:ml-auto" />
                                </Link>
                            );
                        })}
                        <button
                            type="button"
                            onClick={onLogout}
                            className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[13px] text-danger transition-colors hover:bg-danger/5 lg:w-full"
                        >
                            <LogOut className="h-[18px] w-[18px] shrink-0" />
                            <span className="whitespace-nowrap">退出登录</span>
                        </button>
                    </div>
                </div>
            </div>

            <div className="mt-3 hidden space-y-0.5 px-2 text-[11px] text-tertiary lg:block">
                <p>UID {profile.uid}</p>
                {profile.created_at && <p>账户创建于 {formatDate(profile.created_at)}</p>}
            </div>
        </aside>
    );
}
