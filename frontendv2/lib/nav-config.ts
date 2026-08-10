import {
  MessageCircle,
  FolderHeart,
  NotebookPen,
  Cloud,
  BookOpen,
  CalendarClock,
  Settings,
  UserCircle,
  Activity,
  BarChart3,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export type NavPlacement = "primary" | "more" | "account";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  placement: NavPlacement;
}

/**
 * Top navigation configuration - all app features live in the top nav bar.
 *
 * - primary: shown as direct links in the bar
 * - more: collapsed under a "更多" dropdown (low-frequency modules)
 * - account: right-side account area (settings / profile)
 */
export const navItems: NavItem[] = [
  { id: "chat", label: "对话", href: "/chat", icon: MessageCircle, placement: "primary" },
  { id: "favorites", label: "收藏夹", href: "/favorites", icon: FolderHeart, placement: "primary" },
  { id: "notes", label: "笔记", href: "/notes", icon: NotebookPen, placement: "primary" },
  { id: "cloud-drive", label: "云盘", href: "/cloud-drive", icon: Cloud, placement: "primary" },
  { id: "quiz", label: "题目练习", href: "/quiz", icon: BookOpen, placement: "primary" },
  { id: "task-quiz", label: "定时出题", href: "/task-quiz", icon: CalendarClock, placement: "primary" },
  // Low-frequency modules collapsed under "更多"
  { id: "tasks", label: "任务监控", href: "/tasks", icon: Activity, placement: "more" },
  { id: "billing", label: "用量计费", href: "/billing", icon: BarChart3, placement: "more" },
  { id: "skills", label: "技能商店", href: "/skills", icon: Sparkles, placement: "more" },
  // Right-side account area
  { id: "settings", label: "设置", href: "/settings", icon: Settings, placement: "account" },
  { id: "account", label: "个人中心", href: "/account", icon: UserCircle, placement: "account" },
];

export const primaryNavItems = navItems.filter((i) => i.placement === "primary");
export const moreNavItems = navItems.filter((i) => i.placement === "more");
export const accountNavItems = navItems.filter((i) => i.placement === "account");
