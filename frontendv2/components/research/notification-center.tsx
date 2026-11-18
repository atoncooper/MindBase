"use client";

/**
 * 科研通知中心：工具栏铃铛 + 未读角标 + 下拉列表。
 *
 * 数据只经 academicApi（listNotifications / markNotificationRead），组件内不直接
 * fetch；首屏立即拉一次，之后每 30s 轮询（组件卸载时 clearInterval）。面板点击
 * 外部 / Esc 关闭（open 时注册 document 监听，关闭或卸载时清理）。视觉沿用
 * research-ui 的共享原语（Pill / ErrorBanner / EmptyState / LoadingBlock）与 MUI
 * 组件，与科研工作台的 Google Workspace 风格一致。
 *
 * 点击未读条目：先 POST 已读，成功后再更新本地状态与 unreadCount，然后按 link
 * 用 Next router 跳转（项目科研页）。通知是 uid 维度：projectId 只用于把「当前
 * 项目」的条目标记出来，不参与过滤。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronRight, Inbox, RefreshCw } from "lucide-react";
import {
    Box,
    CircularProgress,
    IconButton,
    ListItemButton,
    Stack,
    Tooltip,
    Typography,
} from "@mui/material";
import { academicApi, type AcademicNotification } from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    LoadingBlock,
    Pill,
    formatDateTime,
} from "./research-ui";

/** 轮询间隔：30s（首屏另有一次立即拉取）。 */
const POLL_INTERVAL_MS = 30_000;
/** 列表页大小：最近 20 条；角标计数为全量未读，由后端 unreadCount 返回。 */
const LIST_LIMIT = 20;
/** 正文最多展示 120 字（超出加省略号）。 */
const BODY_PREVIEW_MAX = 120;

/** 通知类型中文文案（未知类型原样兜底）。 */
const TYPE_LABELS: Record<AcademicNotification["type"], string> = {
    approval: "审批",
    experiment: "实验",
    validation: "校验",
    plan: "计划",
    system: "系统",
};

/** 复用 Pill 的 Tailwind 语义色映射（text-* → Google tonal chip）。 */
const TYPE_TONES: Record<AcademicNotification["type"], string> = {
    approval: "text-warning",
    experiment: "text-accent",
    validation: "text-danger",
    plan: "text-success",
    system: "text-secondary",
};

/** 未读 = 没有 readAt 时间戳（契约：absent = unread）。 */
function isUnread(notification: AcademicNotification): boolean {
    return notification.readAt === undefined;
}

/** 列表时间倒序（后端合约已 newest-first，这里再兜底一次）。 */
function newestFirst(notifications: AcademicNotification[]): AcademicNotification[] {
    return [...notifications].sort((a, b) => b.createdAt - a.createdAt);
}

/** 未读数归一化：非法/负数按 0 处理。 */
function normalizeUnreadCount(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** 角标文案：>= 99 显示 99+。 */
function badgeText(count: number): string {
    return count >= 99 ? "99+" : String(count);
}

/** 正文截断到 BODY_PREVIEW_MAX 字（先压缩空白，避免多行正文撑高列表）。 */
function truncateBody(body: string): string {
    const text = body.replace(/\s+/g, " ").trim();
    return text.length <= BODY_PREVIEW_MAX ? text : `${text.slice(0, BODY_PREVIEW_MAX)}…`;
}

/** 相对时间（超过 7 天回落为绝对时间）；绝对时间同时作为 title 提示。 */
function formatRelativeTime(ms: number): string {
    const time = new Date(ms).getTime();
    if (!Number.isFinite(time)) return "—";
    const diff = Date.now() - time;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return formatDateTime(ms) || "—";
}

/**
 * 通知中心入口。`projectId` 可缺省（账号维度）；传入当前项目时只会在列表里
 * 给该项目相关通知加一个「本项目」小标签，不做过滤（后端 API 是 uid 维度）。
 */
export function NotificationCenter({ projectId }: { projectId?: string }) {
    const router = useRouter();
    /** 铃铛 + 面板的公共根：点击外部判定用（点击铃铛自身不算外部）。 */
    const rootRef = useRef<HTMLDivElement | null>(null);
    /** Esc 关闭后把焦点还给铃铛。 */
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    /**
     * 本次会话内已标记已读的 id。轮询响应可能比标记请求更旧，回填时用它把
     * 这些条目强制按已读展示（并同步修正 unreadCount），避免角标闪回。
     */
    const locallyReadRef = useRef<Set<string>>(new Set());

    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState<AcademicNotification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [markError, setMarkError] = useState<string | null>(null);
    const [markingId, setMarkingId] = useState<string | null>(null);

    /** 拉取通知列表；silent = 轮询（不闪 loading）。 */
    const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            const result = await academicApi.listNotifications(LIST_LIMIT);
            const locallyRead = locallyReadRef.current;
            const staleUnread = result.notifications.filter(
                (notification) => notification.readAt === undefined && locallyRead.has(notification.id),
            ).length;
            setNotifications(
                newestFirst(result.notifications).map((notification) =>
                    notification.readAt === undefined && locallyRead.has(notification.id)
                        ? { ...notification, readAt: Date.now() }
                        : notification,
                ),
            );
            setUnreadCount(normalizeUnreadCount(result.unreadCount - staleUnread));
            setError(null);
            setMarkError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载通知失败");
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    // 首屏立即拉取一次；之后每 30s 轮询。组件卸载时清理定时器。
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial notification bootstrap
        void load();
        const timer = window.setInterval(() => {
            void load(true);
        }, POLL_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [load]);

    // 面板打开时监听 document：点击外部关闭、Esc 关闭（关闭/卸载时移除监听）。
    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (rootRef.current?.contains(target)) return;
            setOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setOpen(false);
            buttonRef.current?.focus();
        };
        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open]);

    const toggleOpen = useCallback(() => {
        if (!open) setMarkError(null);
        setOpen(!open);
    }, [open]);

    /**
     * 点击条目：未读先标记已读（成功后更新本地状态 + unreadCount），带 link 时再
     * 关闭面板并跳转；标记失败时展示错误、不跳转，方便用户重试。
     */
    const handleItemClick = useCallback(
        async (notification: AcademicNotification) => {
            if (isUnread(notification)) {
                if (markingId !== null) return;
                setMarkingId(notification.id);
                setMarkError(null);
                try {
                    await academicApi.markNotificationRead(notification.id);
                } catch (e) {
                    setMarkError(e instanceof Error ? e.message : "标记已读失败");
                    setMarkingId(null);
                    return;
                }
                locallyReadRef.current.add(notification.id);
                setNotifications((previous) =>
                    previous.map((item) =>
                        item.id === notification.id ? { ...item, readAt: Date.now() } : item,
                    ),
                );
                setUnreadCount((previous) => Math.max(0, previous - 1));
                setMarkingId(null);
            }
            if (notification.link) {
                setOpen(false);
                router.push(notification.link);
            }
        },
        [markingId, router],
    );

    return (
        <Box ref={rootRef} sx={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
            <Tooltip title={unreadCount > 0 ? `${unreadCount} 条未读通知` : "通知"}>
                <IconButton
                    ref={buttonRef}
                    aria-label={unreadCount > 0 ? `通知，${unreadCount} 条未读` : "通知"}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    onClick={toggleOpen}
                    sx={{ border: 1, borderColor: "divider", borderRadius: "8px", color: "text.secondary" }}
                >
                    <Bell size={16} aria-hidden="true" />
                </IconButton>
            </Tooltip>
            {unreadCount > 0 && (
                <Box
                    aria-hidden="true"
                    sx={{
                        position: "absolute",
                        top: -5,
                        right: -5,
                        display: "grid",
                        placeItems: "center",
                        minWidth: 16,
                        height: 16,
                        px: unreadCount >= 10 ? 0.5 : 0,
                        borderRadius: "8px",
                        bgcolor: "error.main",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 600,
                        lineHeight: 1,
                        pointerEvents: "none",
                    }}
                >
                    {badgeText(unreadCount)}
                </Box>
            )}

            {open && (
                <Box
                    role="dialog"
                    aria-label="通知中心"
                    sx={{
                        position: "absolute",
                        top: "calc(100% + 8px)",
                        right: 0,
                        zIndex: (theme) => theme.zIndex.modal,
                        display: "flex",
                        flexDirection: "column",
                        width: "min(380px, calc(100vw - 32px))",
                        bgcolor: "background.paper",
                        border: 1,
                        borderColor: "divider",
                        borderRadius: "12px",
                        boxShadow: (theme) => theme.shadows[8],
                        overflow: "hidden",
                    }}
                >
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            px: 2,
                            py: 1.25,
                            borderBottom: 1,
                            borderColor: "divider",
                        }}
                    >
                        <Typography sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                            通知
                        </Typography>
                        {unreadCount > 0 && (
                            <Pill className="text-accent">{`${unreadCount} 条未读`}</Pill>
                        )}
                        <Tooltip title="刷新">
                            <span>
                                <IconButton
                                    aria-label="刷新通知"
                                    size="small"
                                    disabled={loading}
                                    onClick={() => void load()}
                                    sx={{ color: "text.secondary" }}
                                >
                                    {loading ? (
                                        <CircularProgress size={14} thickness={5} />
                                    ) : (
                                        <RefreshCw size={14} aria-hidden="true" />
                                    )}
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Box>

                    <Box sx={{ maxHeight: "min(420px, calc(100dvh - 240px))", overflowY: "auto" }}>
                        {error && (
                            <Box sx={{ p: 1.5 }}>
                                <ErrorBanner message={error} onRetry={() => void load()} />
                            </Box>
                        )}
                        {markError && (
                            <Box sx={{ px: 1.5, pb: 0, pt: error ? 0.75 : 1.5 }}>
                                <ErrorBanner message={markError} />
                            </Box>
                        )}
                        {loading && notifications.length === 0 ? (
                            <LoadingBlock label="加载通知…" />
                        ) : notifications.length === 0 ? (
                            error ? null : (
                                <EmptyState
                                    icon={Inbox}
                                    title="暂无通知"
                                    description="审批、实验完成、校验失败与计划事件会在这里提醒你。"
                                />
                            )
                        ) : (
                            <Box>
                                {notifications.map((notification) => {
                                    const unread = isUnread(notification);
                                    const currentProject =
                                        projectId !== undefined && notification.projectId === projectId;
                                    return (
                                        <ListItemButton
                                            key={notification.id}
                                            alignItems="flex-start"
                                            disabled={markingId === notification.id}
                                            onClick={() => void handleItemClick(notification)}
                                            aria-label={`${TYPE_LABELS[notification.type]}通知：${notification.title}`}
                                            sx={{
                                                gap: 1,
                                                px: 2,
                                                py: 1.25,
                                                borderBottom: 1,
                                                borderColor: "divider",
                                                bgcolor: unread ? "action.hover" : "transparent",
                                                "&:last-of-type": { borderBottom: 0 },
                                            }}
                                        >
                                            <Box
                                                sx={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    width: 10,
                                                    flexShrink: 0,
                                                    pt: "5px",
                                                }}
                                            >
                                                <Box
                                                    sx={{
                                                        width: 8,
                                                        height: 8,
                                                        borderRadius: "50%",
                                                        bgcolor: unread ? "primary.main" : "transparent",
                                                    }}
                                                />
                                            </Box>
                                            <Box sx={{ flex: 1, minWidth: 0 }}>
                                                <Typography
                                                    sx={{
                                                        fontSize: 13,
                                                        lineHeight: 1.4,
                                                        fontWeight: unread ? 600 : 400,
                                                        wordBreak: "break-word",
                                                    }}
                                                >
                                                    {notification.title}
                                                </Typography>
                                                <Stack
                                                    direction="row"
                                                    spacing={0.75}
                                                    useFlexGap
                                                    sx={{
                                                        mt: 0.5,
                                                        alignItems: "center",
                                                        flexWrap: "wrap",
                                                        rowGap: 0.5,
                                                    }}
                                                >
                                                    <Pill className={TYPE_TONES[notification.type]}>
                                                        {TYPE_LABELS[notification.type]}
                                                    </Pill>
                                                    {currentProject && (
                                                        <Pill className="text-accent">本项目</Pill>
                                                    )}
                                                    <Typography
                                                        variant="caption"
                                                        color="text.secondary"
                                                        title={formatDateTime(notification.createdAt)}
                                                    >
                                                        {formatRelativeTime(notification.createdAt)}
                                                    </Typography>
                                                    {markingId === notification.id && (
                                                        <CircularProgress size={10} thickness={6} />
                                                    )}
                                                </Stack>
                                                {notification.body ? (
                                                    <Typography
                                                        variant="caption"
                                                        color="text.secondary"
                                                        sx={{
                                                            display: "block",
                                                            mt: 0.5,
                                                            lineHeight: 1.5,
                                                            wordBreak: "break-word",
                                                        }}
                                                    >
                                                        {truncateBody(notification.body)}
                                                    </Typography>
                                                ) : null}
                                            </Box>
                                            {notification.link && (
                                                <ChevronRight
                                                    size={14}
                                                    aria-hidden="true"
                                                    style={{ flexShrink: 0, marginTop: 3, opacity: 0.45 }}
                                                />
                                            )}
                                        </ListItemButton>
                                    );
                                })}
                            </Box>
                        )}
                    </Box>

                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 1,
                            px: 2,
                            py: 1,
                            borderTop: 1,
                            borderColor: "divider",
                        }}
                    >
                        <Typography variant="caption" color="text.secondary">
                            每 30 秒自动刷新
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                            {notifications.length > 0 ? `最近 ${notifications.length} 条` : `最近 ${LIST_LIMIT} 条`}
                        </Typography>
                    </Box>
                </Box>
            )}
        </Box>
    );
}
