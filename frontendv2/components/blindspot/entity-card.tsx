"use client";

/**
 * EntityCard - single entity card on the blind-spot map.
 *
 * Collapsed: name/type + exposure and quiz signal badges. Expanded:
 * review path (video title + page + quote) plus quiz/graph CTAs.
 */
import { useState } from "react";
import {
    BookOpenCheck,
    ChevronDown,
    Eye,
    EyeOff,
    HelpCircle,
    Loader2,
    Waypoints,
} from "lucide-react";
import { blindspotApi, type BlindspotEntity } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ReviewPathItem } from "@/lib/api";

interface Props {
    entity: BlindspotEntity;
    expanded: boolean;
    generating: boolean;
    anyGenerating: boolean;
    onToggle: () => void;
    onGenerateQuiz: () => void;
}

export function EntityCard({
    entity,
    expanded,
    generating,
    anyGenerating,
    onToggle,
    onGenerateQuiz,
}: Props) {
    const [detail, setDetail] = useState<Awaited<
        ReturnType<typeof blindspotApi.getEntity>
    > | null>(null);
    const [detailError, setDetailError] = useState("");

    const toggle = async () => {
        onToggle();
        if (!expanded && !detail) {
            try {
                setDetail(await blindspotApi.getEntity(entity.eid));
            } catch (e) {
                setDetailError(e instanceof Error ? e.message : "详情加载失败");
            }
        }
    };

    return (
        <div className="rounded-2xl border border-border-subtle bg-surface">
            <button
                type="button"
                onClick={() => void toggle()}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
            >
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-foreground">
                        {entity.name}
                        <span className="ml-2 rounded-full bg-border-subtle px-2 py-0.5 text-[10px] font-normal text-secondary">
                            {entity.type}
                        </span>
                        {entity.probed && (
                            <span
                                className="ml-1.5 inline-flex items-center align-middle text-accent"
                                title="你在对话中追问过该概念"
                            >
                                <HelpCircle className="h-3 w-3" />
                            </span>
                        )}
                    </p>
                    {entity.description && (
                        <p className="mt-0.5 truncate text-[12px] text-secondary">
                            {entity.description}
                        </p>
                    )}
                </div>
                <SignalBadges entity={entity} />
                <ChevronDown
                    className={cn(
                        "h-4 w-4 shrink-0 text-secondary transition-transform",
                        expanded && "rotate-180",
                    )}
                />
            </button>

            {expanded && (
                <div className="border-t border-border-subtle px-4 py-3.5">
                    {detailError && <p className="text-[12px] text-danger">{detailError}</p>}
                    {!detail && !detailError && (
                        <p className="flex items-center gap-2 text-[12px] text-secondary">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载复习路径…
                        </p>
                    )}
                    {detail && detail.review_path.length === 0 && (
                        <p className="text-[12px] text-secondary">暂无视频出处</p>
                    )}
                    {detail && detail.review_path.length > 0 && (
                        <ul className="space-y-2">
                            {detail.review_path.slice(0, 8).map((item) => (
                                <PathItem key={`${item.bvid}:${item.page_index}`} item={item} />
                            ))}
                        </ul>
                    )}

                    <div className="mt-3.5 flex justify-end gap-2">
                        <a
                            href={`/graph?center=${encodeURIComponent(entity.eid)}`}
                            className="btn-pill btn-ghost inline-flex h-8 items-center gap-1.5 px-3.5 text-[12px]"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <Waypoints className="h-3.5 w-3.5" />
                            图谱中查看
                        </a>
                        <button
                            type="button"
                            disabled={anyGenerating}
                            onClick={onGenerateQuiz}
                            className="btn-pill btn-primary inline-flex h-8 items-center gap-1.5 px-4 text-[12px] disabled:opacity-50"
                        >
                            {generating ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <BookOpenCheck className="h-3.5 w-3.5" />
                            )}
                            针对此薄弱点出 5 道题
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function SignalBadges({ entity }: { entity: BlindspotEntity }) {
    return (
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-secondary">
            <span
                className="inline-flex items-center gap-1 rounded-full bg-border-subtle px-2 py-0.5 tabular-nums"
                title={`出现在 ${entity.exposure} 个分P`}
            >
                <Eye className="h-3 w-3" />
                {entity.exposure}
            </span>
            {entity.quiz_total > 0 ? (
                <span
                    className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 tabular-nums",
                        entity.quiz_wrong > entity.quiz_correct
                            ? "bg-danger/10 text-danger"
                            : "bg-success/10 text-success",
                    )}
                    title={`答题 ${entity.quiz_correct}/${entity.quiz_total} 正确`}
                >
                    <BookOpenCheck className="h-3 w-3" />
                    {entity.quiz_correct}/{entity.quiz_total}
                </span>
            ) : (
                <span
                    className="inline-flex items-center gap-1 rounded-full bg-border-subtle px-2 py-0.5"
                    title="尚未验证过"
                >
                    <EyeOff className="h-3 w-3" />
                    未验证
                </span>
            )}
        </div>
    );
}

function PathItem({ item }: { item: ReviewPathItem }) {
    return (
        <li className="rounded-xl bg-surface-elevated px-3 py-2">
            <p className="truncate text-[12px] font-medium text-foreground">
                {item.title}
                <span className="ml-1.5 text-[10px] font-normal text-secondary">
                    P{item.page_index + 1}
                </span>
            </p>
            {item.quote && (
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-secondary">
                    “{item.quote}”
                </p>
            )}
        </li>
    );
}
