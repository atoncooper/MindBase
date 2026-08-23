"use client";

/**
 * BlindspotView - knowledge blind-spot map view (Plan 1.0.6).
 *
 * Five-quadrant entity list: danger/blind first; cards expand into a
 * review path (evidence quotes + pages) with one-click targeted quiz.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Compass, RefreshCw, Target } from "lucide-react";
import {
    blindspotApi,
    QUADRANT_LABELS,
    type Quadrant,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { EntityCard } from "./entity-card";

type LoadState = "loading" | "ready" | "error";

const QUADRANT_ORDER: Quadrant[] = [
    "danger",
    "blind",
    "learning",
    "familiar",
    "unexplored",
];

const QUADRANT_DESC: Record<Quadrant, string> = {
    danger: "反复出现却反复答错，最优先复习",
    blind: "见过多次、从未验证、也没问过 —— 自以为懂了",
    learning: "你主动追问过，正在补",
    familiar: "有验证且正确率达标",
    unexplored: "只路过一次，还没真正接触",
};

const QUADRANT_ACCENT: Record<Quadrant, string> = {
    danger: "text-danger bg-danger/8 border-danger/25",
    blind: "text-amber-600 bg-amber-500/8 border-amber-500/25",
    learning: "text-accent bg-accent-soft border-accent/25",
    familiar: "text-success bg-success/8 border-success/25",
    unexplored: "text-secondary bg-border-subtle border-border-subtle",
};

export function BlindspotView() {
    const [state, setState] = useState<LoadState>("loading");
    const [loadError, setLoadError] = useState("");
    const [map, setMap] = useState<Awaited<ReturnType<typeof blindspotApi.getMap>> | null>(null);
    const [activeQuadrant, setActiveQuadrant] = useState<Quadrant>("danger");
    const [expandedEid, setExpandedEid] = useState<string | null>(null);
    const [generatingEid, setGeneratingEid] = useState<string | null>(null);
    const [quizStarted, setQuizStarted] = useState<{ title: string } | null>(null);

    const load = useCallback(async () => {
        setState("loading");
        setLoadError("");
        try {
            const m = await blindspotApi.getMap();
            setMap(m);
            const firstNonEmpty =
                QUADRANT_ORDER.find((q) => (m.quadrants[q]?.length ?? 0) > 0) ?? "danger";
            setActiveQuadrant(firstNonEmpty);
            setState("ready");
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : "盲区地图加载失败");
            setState("error");
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    const handleGenerateQuiz = useCallback(
        async (eid: string) => {
            if (generatingEid) return;
            setGeneratingEid(eid);
            try {
                const res = await blindspotApi.generateQuiz(eid, 5, "medium");
                setQuizStarted({ title: res.title });
                setExpandedEid(null);
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : "发起出题失败");
            } finally {
                setGeneratingEid(null);
            }
        },
        [generatingEid],
    );

    const entities = useMemo(() => map?.quadrants[activeQuadrant] ?? [], [map, activeQuadrant]);

    if (state === "loading") {
        return (
            <Shell>
                <Header onRefresh={() => {}} refreshing={false} />
                <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-20 animate-pulse rounded-2xl bg-border-subtle" />
                    ))}
                </div>
            </Shell>
        );
    }

    if (state === "error") {
        return (
            <Shell>
                <Header onRefresh={() => void load()} refreshing={false} />
                {loadError && (
                    <Banner tone="danger" text={loadError} onClose={() => setLoadError("")} />
                )}
                <div className="flex flex-col items-center rounded-2xl border border-border-subtle py-16 text-center">
                    <AlertCircle className="h-7 w-7 text-danger" />
                    <p className="mt-3 text-[14px] text-foreground">{loadError}</p>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]"
                    >
                        重试
                    </button>
                </div>
            </Shell>
        );
    }

    if (!map) return null;

    return (
        <Shell>
            <Header onRefresh={() => void load()} refreshing={false} />

            {quizStarted && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-success/20 bg-success/5 px-3.5 py-2.5 text-[12px] text-success">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">
                        已创建练习「{quizStarted.title}」，正在生成题目，前往{" "}
                        <a href="/quiz" className="underline underline-offset-2">题目练习</a> 查看
                    </span>
                    <button
                        type="button"
                        onClick={() => setQuizStarted(null)}
                        className="text-success/70 hover:text-success"
                        aria-label="关闭"
                    >
                        ×
                    </button>
                </div>
            )}

            {!map.available && (
                <EmptyCard
                    icon={<Compass className="h-5 w-5" />}
                    title="知识图谱不可用"
                    hint="盲区地图基于知识图谱。请确认 Neo4j 已连接并完成一次图谱构建。"
                />
            )}

            {map.available && map.stats.total_entities === 0 && (
                <EmptyCard
                    icon={<Target className="h-5 w-5" />}
                    title="暂无图谱数据"
                    hint="先在收藏夹页同步视频并构建知识库与知识图谱，这里就会生成你的专属盲区地图。"
                    action={
                        <a href="/favorites" className="btn-pill btn-primary mt-6 inline-flex h-9 items-center px-5 text-[13px]">
                            去收藏夹构建
                        </a>
                    }
                />
            )}

            {map.available && map.stats.total_entities > 0 && (
                <>
                    <div className="flex flex-wrap gap-2">
                        {QUADRANT_ORDER.map((q) => {
                            const count = map.stats[q] ?? 0;
                            const active = q === activeQuadrant;
                            return (
                                <button
                                    key={q}
                                    type="button"
                                    onClick={() => {
                                        setActiveQuadrant(q);
                                        setExpandedEid(null);
                                    }}
                                    className={cn(
                                        "rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                                        active
                                            ? QUADRANT_ACCENT[q]
                                            : "border-border-subtle text-secondary hover:bg-border-subtle",
                                    )}
                                >
                                    {QUADRANT_LABELS[q]} · {count}
                                </button>
                            );
                        })}
                    </div>

                    <p className="mt-3 text-[12px] text-secondary">{QUADRANT_DESC[activeQuadrant]}</p>

                    {entities.length === 0 ? (
                        <p className="mt-10 text-center text-[13px] text-secondary">
                            该象限暂时没有实体
                        </p>
                    ) : (
                        <div className="mt-4 space-y-2.5">
                            {entities.map((ent) => (
                                <EntityCard
                                    key={ent.eid}
                                    entity={ent}
                                    expanded={expandedEid === ent.eid}
                                    generating={generatingEid === ent.eid}
                                    anyGenerating={generatingEid !== null}
                                    onToggle={() =>
                                        setExpandedEid(expandedEid === ent.eid ? null : ent.eid)
                                    }
                                    onGenerateQuiz={() => void handleGenerateQuiz(ent.eid)}
                                />
                            ))}
                        </div>
                    )}
                </>
            )}
        </Shell>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return <div className="mx-auto max-w-[860px] px-5 py-8 pb-24">{children}</div>;
}

function Header({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
    return (
        <div className="mb-6 flex items-end justify-between">
            <div>
                <h1 className="text-[26px] font-semibold tracking-tight text-foreground">知识盲区</h1>
                <p className="mt-0.5 text-[13px] text-secondary">
                    聚合你的曝光、答题与追问记录，找出自以为懂了的概念
                </p>
            </div>
            <button
                type="button"
                disabled={refreshing}
                onClick={onRefresh}
                title="刷新"
                className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:opacity-50"
            >
                <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </button>
        </div>
    );
}

function Banner({
    tone,
    text,
    onClose,
}: {
    tone: "danger" | "success";
    text: string;
    onClose: () => void;
}) {
    const cls =
        tone === "danger"
            ? "border-danger/20 bg-danger/5 text-danger"
            : "border-success/20 bg-success/5 text-success";
    return (
        <div className={cn("mb-4 flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px]", cls)}>
            {tone === "danger" ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            ) : (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="flex-1">{text}</span>
            <button
                type="button"
                onClick={onClose}
                className="opacity-70 hover:opacity-100"
                aria-label="关闭"
            >
                ×
            </button>
        </div>
    );
}

function EmptyCard({
    icon,
    title,
    hint,
    action,
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-border-subtle py-20 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-border-subtle text-secondary">
                {icon}
            </span>
            <p className="mt-4 text-[15px] font-medium text-foreground">{title}</p>
            <p className="mt-1.5 max-w-xs text-[13px] text-secondary">{hint}</p>
            {action}
        </div>
    );
}
