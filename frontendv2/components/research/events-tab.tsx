"use client";

/**
 * 动态 Tab：项目事件流（只读）。事件由 agent 或用户操作追加，按时间倒序展示
 * 类型中文标签、发起者与关键 payload（如阶段、citeKey、字数）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { academicApi, type AcademicEventRecord } from "@/lib/api";
import {
    EmptyState,
    ErrorBanner,
    EVENT_LABELS,
    LoadingBlock,
    formatDateTime,
} from "./research-ui";

/** payload 只展示短标量，避免把大对象塞进时间线。 */
function payloadSummary(payload: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            const text = String(value);
            parts.push(`${key}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
        }
        if (parts.length >= 4) break;
    }
    return parts.join(" · ");
}

export function EventsTab({ projectId }: { projectId: string }) {
    const [events, setEvents] = useState<AcademicEventRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState(false);
    const streamRef = useRef<EventSource | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await academicApi.listEvents(projectId, 50);
            setEvents(result.events);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载动态失败");
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    // SSE：服务端每 2s 推送新事件；浏览器断线会自动重连，失败时保留手动刷新。
    useEffect(() => {
        if (typeof EventSource === "undefined") return;
        const source = new EventSource(academicApi.eventsStreamUrl(projectId));
        streamRef.current = source;
        source.onopen = () => setLive(true);
        source.onerror = () => setLive(false);
        source.onmessage = (message) => {
            try {
                const event = JSON.parse(message.data) as AcademicEventRecord;
                setEvents((previous) => {
                    if (previous.some((item) => item.id === event.id)) return previous;
                    return [event, ...previous].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
                });
            } catch {
                // 忽略非法帧
            }
        };
        return () => {
            source.close();
            streamRef.current = null;
            setLive(false);
        };
    }, [projectId]);

    if (loading) return <LoadingBlock label="加载动态…" />;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-tertiary">
                    <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-success" : "bg-border")} />
                    {live ? "实时更新中" : "未连接实时流"}
                </span>
                <button
                    type="button"
                    onClick={() => void load()}
                    className="rounded-full border border-border px-2.5 py-1 text-[11px] text-foreground"
                >
                    刷新
                </button>
            </div>
            {error && <ErrorBanner message={error} onRetry={() => void load()} />}
            {events.length === 0 ? (
                <EmptyState icon={Activity} title="还没有动态" description="创建项目、推进阶段、导入文献或保存章节后，这里会出现记录。" />
            ) : (
                <ol className="relative space-y-3 border-l border-border-subtle pl-4">
                    {events.map((event) => (
                        <li key={event.id} className="relative">
                            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border" />
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-[13px] font-medium text-foreground">
                                    {EVENT_LABELS[event.type] ?? event.type}
                                </span>
                                <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                    {event.actor === "agent" ? "智能体" : "我"}
                                </span>
                                <span className="text-[11px] text-tertiary">{formatDateTime(event.createdAt)}</span>
                            </div>
                            {Object.keys(event.payload).length > 0 && (
                                <p className="mt-1 break-words text-[11px] text-secondary">
                                    {payloadSummary(event.payload)}
                                </p>
                            )}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
