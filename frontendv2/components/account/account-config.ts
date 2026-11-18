import {
    Gauge,
    KeyRound,
    LayoutGrid,
    Mail,
    Settings,
    Smartphone,
    Sparkles,
    Terminal,
    Tv,
    UserRound,
    Crown,
    type LucideIcon,
} from "lucide-react";

/** 个人中心右侧内容区可切换的页面。 */
export type SectionKey =
    | "overview"
    | "profile"
    | "email"
    | "phone"
    | "password"
    | "bilibili"
    | "membership"
    | "quota"
    | "coding-plan";

export interface SectionMeta {
    title: string;
    description: string;
}

export const SECTION_META: Record<SectionKey, SectionMeta> = {
    overview: {
        title: "账户概览",
        description: "管理你的个人资料、登录方式、会员权益与 AI 用量。",
    },
    profile: {
        title: "个人资料",
        description: "这些信息会展示在个人中心与公开页面中，仅你本人可以修改。",
    },
    email: {
        title: "邮箱与验证",
        description: "绑定并验证邮箱，用于登录、找回密码与安全通知。",
    },
    phone: {
        title: "手机号与短信",
        description: "绑定手机号用于身份验证；短信服务未配置时仅支持未验证绑定。",
    },
    password: {
        title: "密码与安全",
        description: "修改密码需要当前密码，并通过已验证邮箱或短信完成二次验证。",
    },
    bilibili: {
        title: "B 站账号授权",
        description: "授权后可同步收藏夹与视频列表，并构建属于你的知识库。",
    },
    membership: {
        title: "会员与订阅",
        description: "查看当前会员等级、有效期与专属权益。",
    },
    quota: {
        title: "用量与额度",
        description: "每日 0 点（Asia/Shanghai）重置，仅统计成功的调用。",
    },
    "coding-plan": {
        title: "编程套餐",
        description: "为站内 Code Agent 添加第三方编程套餐，仅 VIP / SVIP 可用。",
    },
};

export function isSectionKey(value: string): value is SectionKey {
    return Object.prototype.hasOwnProperty.call(SECTION_META, value);
}

export interface NavItem {
    key: SectionKey;
    label: string;
    icon: LucideIcon;
}

export interface NavGroup {
    label: string;
    items: NavItem[];
}

/** 侧边导航分组：账户 / 登录与安全 / 服务与权益。 */
export const NAV_GROUPS: NavGroup[] = [
    {
        label: "账户",
        items: [
            { key: "overview", label: "概览", icon: LayoutGrid },
            { key: "profile", label: "个人资料", icon: UserRound },
        ],
    },
    {
        label: "登录与安全",
        items: [
            { key: "email", label: "邮箱", icon: Mail },
            { key: "phone", label: "手机号", icon: Smartphone },
            { key: "password", label: "密码", icon: KeyRound },
            { key: "bilibili", label: "B 站账号", icon: Tv },
        ],
    },
    {
        label: "服务与权益",
        items: [
            { key: "membership", label: "会员与订阅", icon: Crown },
            { key: "quota", label: "用量与额度", icon: Gauge },
            { key: "coding-plan", label: "Coding Plan", icon: Terminal },
        ],
    },
];

/** 侧边栏底部的站内快捷入口（离开个人中心，用 ↗ 标识）。 */
export const QUICK_LINKS: Array<{ label: string; href: string; icon: LucideIcon }> = [
    { label: "技能商店", href: "/skills", icon: Sparkles },
    { label: "设置", href: "/settings", icon: Settings },
];
