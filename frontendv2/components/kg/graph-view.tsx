"use client";

/**
 * GraphView - knowledge graph visualization page (added in Plan 1.0.6).
 *
 * Overview loads the head-entity subgraph; clicking a node re-centers
 * the layout on it via BFS; the side panel shows details and links out.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Waypoints } from "lucide-react";
import { kgApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ForceGraph, TYPE_COLORS } from "./force-graph";

type LoadState = "loading" | "ready" | "error";

export function GraphView({ initialCenter }: { initialCenter?: string }) {
    const [state, setState] = useState<LoadState>("loading");
    const [error, setError] = useState("");
    const [data, setData] = useState<Awaited<ReturnType<typeof kgApi.getSubgraph>> | null>(
        null,
    );
    const [selected, setSelected] = useState<string | null>(initialCenter ?? null);

    const load = useCallback(async (center?: string) => {
        setState("loading");
        setError("");
        try {
            const d = await kgApi.getSubgraph(
                center ? { center, depth: 2, maxNodes: 80 } : { maxNodes: 80 },
            );
            setData(d);
            setSelected(center ?? null);
            setState("ready");
        } catch (e) {
            setError(e instanceof Error ? e.message : "图谱加载失败");
            setState("error");
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load(initialCenter);
    }, [load, initialCenter]);

    const selectedNode = data?.nodes.find((n) => n.eid === selected) ?? null;

    return (
        <div className="mx-auto max-w-[1100px] px-5 py-8 pb-24">
            <div className="mb-6 flex items-end justify-between">
                <div>
                    <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
                        知识图谱
                    </h1>
                    <p className="mt-0.5 text-[13px] text-secondary">
                        实体与关系的可视化网络 · 点击节点查看关联 / 拖拽调整布局
                    </p>
                </div>
                <button
                    type="button"
                    disabled={state === "loading"}
                    onClick={() => void load()}
                    className="btn-pill btn-ghost inline-flex h-8 items-center gap-1.5 px-3.5 text-[12px] disabled:opacity-50"
                >
                    <RefreshCw className={cn("h-3.5 w-3.5", state === "loading" && "animate-spin")} />
                    总览模式
                </button>
            </div>

            {state === "loading" && (
                <div className="grid h-[560px] place-items-center rounded-2xl border border-border-subtle bg-surface">
                    <span className="flex items-center gap-2 text-[13px] text-secondary">
                        <Loader2 className="h-4 w-4 animate-spin" /> 正在加载图谱…
                    </span>
                </div>
            )}

            {state === "error" && (
                <div className="flex flex-col items-center rounded-2xl border border-border-subtle py-16 text-center">
                    <AlertCircle className="h-7 w-7 text-danger" />
                    <p className="mt-3 text-[14px] text-foreground">{error}</p>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="btn-pill btn-primary mt-5 h-9 px-5 text-[13px]"
                    >
                        重试
                    </button>
                </div>
            )}

            {state === "ready" && data && !data.available && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border-subtle py-20 text-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-border-subtle text-secondary">
                        <Waypoints className="h-5 w-5" />
                    </span>
                    <p className="mt-4 text-[15px] font-medium text-foreground">知识图谱不可用</p>
                    <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                        Neo4j 未连接。请启动 neo4j 服务并在收藏夹页完成一次图谱构建。
                    </p>
                </div>
            )}

            {state === "ready" && data && data.available && data.nodes.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-border-subtle py-20 text-center">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-border-subtle text-secondary">
                        <Waypoints className="h-5 w-5" />
                    </span>
                    <p className="mt-4 text-[15px] font-medium text-foreground">图谱还是空的</p>
                    <p className="mt-1.5 max-w-xs text-[13px] text-secondary">
                        先在收藏夹页构建知识库与知识图谱，实体关系会出现在这里。
                    </p>
                </div>
            )}

            {state === "ready" && data && data.available && data.nodes.length > 0 && (
                <div className="grid grid-cols-[1fr_260px] gap-4 max-lg:grid-cols-1">
                    <ForceGraph
                        nodes={data.nodes}
                        edges={data.edges}
                        centerEid={data.center}
                        selectedEid={selected}
                        onSelect={(eid) => {
                            setSelected(eid);
                            void load(eid);
                        }}
                    />

                    {/* Info side panel */}
                    <aside className="rounded-2xl border border-border-subtle bg-surface p-4">
                        {selectedNode ? (
                            <>
                                <p className="text-[15px] font-semibold text-foreground">
                                    {selectedNode.name}
                                </p>
                                <span
                                    className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px]"
                                    style={{
                                        background: `${TYPE_COLORS[selectedNode.type] ?? TYPE_COLORS.other}22`,
                                        color: TYPE_COLORS[selectedNode.type] ?? TYPE_COLORS.other,
                                    }}
                                >
                                    {selectedNode.type} · {selectedNode.degree} 条关系
                                </span>
                                {selectedNode.description && (
                                    <p className="mt-3 text-[12px] leading-relaxed text-secondary">
                                        {selectedNode.description}
                                    </p>
                                )}
                                <div className="mt-4 space-y-2">
                                    <a
                                        href={`/blindspot?center=${selectedNode.eid}`}
                                        className="btn-pill btn-ghost block h-8 leading-8 text-center text-[12px]"
                                    >
                                        在盲区地图中查看
                                    </a>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSelected(null);
                                            void load();
                                        }}
                                        className="btn-pill btn-ghost block h-8 w-full text-[12px]"
                                    >
                                        返回总览
                                    </button>
                                </div>
                            </>
                        ) : (
                            <p className="text-[12px] leading-relaxed text-secondary">
                                点击任意节点：以它为中心重新展开关联子图。
                                <br />
                                <br />
                                节点大小 = 子图内关系数；颜色 = 实体类型；
                                拖拽可调整布局；按钮区可缩放。
                            </p>
                        )}
                        {data.center && (
                            <p className="mt-3 truncate border-t border-border-subtle pt-3 text-[10px] text-secondary">
                                当前中心：{data.nodes.find((n) => n.eid === data.center)?.name ?? "-"}
                            </p>
                        )}
                    </aside>
                </div>
            )}
        </div>
    );
}
