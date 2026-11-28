"use client";

/**
 * ChatHistoryRail - 聊天右侧的用户消息历史轨迹条（参考 ChatGPT 的消息导航）。
 *
 * 行为约定：
 *   - 每条用户消息一个标记点，少于 2 条用户消息时不显示标记；
 *   - 标记点悬停/键盘聚焦时显示截断后的消息预览；
 *   - 点击/键盘激活后由 ChatView 平滑滚动到对应消息，并按滚动位置高亮
 *     「当前」标记（虚拟列表只挂载可视区附近的行，因此用滚动位置 + DOM 锚点
 *     计算，而不是 IntersectionObserver：未挂载的行没有可观察的节点）。
 *   - lg 以下隐藏（窄屏没有右侧留白，避免遮挡内容）；布局空间由 ChatView
 *     固定预留，出现/消失不会引起回流抖动。
 */

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";

/** 一个用户消息锚点。text 只用于生成悬浮预览，不参与渲染正文。 */
export interface ChatHistoryItem {
    /** 用户消息稳定 id，与消息行上的 data-chat-anchor 一致 */
    id: string;
    /** 用户消息正文（内部压缩为单行并截断） */
    text: string;
}

/** 悬浮预览最大字符数。 */
const PREVIEW_MAX_CHARS = 80;
/** 视口顶部下方多少像素内的最后一条用户消息视为「当前」。 */
const ACTIVE_LINE_PX = 64;

/** 把消息正文压成单行预览（去掉多余空白，超长截断）。 */
function toPreview(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return "（空消息）";
    return compact.length > PREVIEW_MAX_CHARS
        ? `${compact.slice(0, PREVIEW_MAX_CHARS)}…`
        : compact;
}

export function ChatHistoryRail({
    items,
    scrollerRef,
    onJump,
}: {
    items: ChatHistoryItem[];
    /** 消息虚拟列表的滚动容器（Virtuoso 的 scroller）。 */
    scrollerRef: RefObject<HTMLElement | null>;
    /** 点击标记：由 ChatView 负责滚动到对应消息。 */
    onJump: (messageId: string) => void;
}) {
    const [activeId, setActiveId] = useState<string | null>(null);
    // 只有 id 序列变化才需要重新绑定监听（流式 token 只改正文，不改 id）。
    const itemsKey = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);

    // 以滚动容器顶部为参考线，取参考线以上最后一条用户消息为「当前」。
    const resolveActiveId = useCallback((): string | null => {
        const scroller = scrollerRef.current;
        if (!scroller) return null;
        const anchors = scroller.querySelectorAll<HTMLElement>("[data-chat-anchor]");
        if (anchors.length === 0) return null;
        const threshold = scroller.getBoundingClientRect().top + ACTIVE_LINE_PX;
        let current: string | null = null;
        for (const anchor of anchors) {
            if (anchor.getBoundingClientRect().top > threshold) break;
            current = anchor.dataset.chatAnchor ?? current;
        }
        // 参考线以上还没有用户消息行时，第一条用户消息视为当前。
        return current ?? anchors[0]?.dataset.chatAnchor ?? null;
    }, [scrollerRef]);

    useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        let frame = 0;
        const update = () => {
            frame = 0;
            setActiveId(resolveActiveId());
        };
        // 滚动事件按帧合并，避免高频 scroll 触发多次渲染。
        const schedule = () => {
            if (frame !== 0) return;
            frame = requestAnimationFrame(update);
        };
        scroller.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule);
        // 首次挂载 / 会话切换 / 追加用户消息后重新计算一次。
        const raf = requestAnimationFrame(update);
        return () => {
            cancelAnimationFrame(raf);
            if (frame !== 0) cancelAnimationFrame(frame);
            scroller.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
        };
    }, [itemsKey, resolveActiveId, scrollerRef]);

    const hasMarkers = items.length >= 2;

    return (
        <nav
            aria-label="对话消息历史导航"
            aria-hidden={hasMarkers ? undefined : true}
            className="hidden w-6 shrink-0 flex-col items-center lg:flex"
        >
            {hasMarkers && (
                <div className="my-auto flex max-h-full w-full flex-col items-center gap-1 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {items.map((item, index) => {
                        const active = item.id === activeId;
                        const preview = toPreview(item.text);
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                    setActiveId(item.id);
                                    onJump(item.id);
                                }}
                                aria-label={`跳转到第 ${index + 1} 条用户消息：${preview}`}
                                aria-current={active ? "location" : undefined}
                                className="group relative flex h-2.5 w-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                            >
                                <span
                                    aria-hidden="true"
                                    className={`block rounded-full transition-all ${active
                                        ? "h-[3px] w-4 bg-foreground"
                                        : "h-[2px] w-3 bg-tertiary/60 group-hover:bg-secondary"
                                        }`}
                                />
                                <span
                                    role="tooltip"
                                    aria-hidden="true"
                                    className="pointer-events-none absolute right-full top-1/2 mr-2 max-w-[240px] -translate-y-1/2 truncate rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-tight text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                                >
                                    {preview}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </nav>
    );
}
