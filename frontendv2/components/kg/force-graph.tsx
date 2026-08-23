"use client";

/**
 * ForceGraph - knowledge graph force-directed visualization (added in 1.0.6).
 *
 * Dependency-free SVG: Coulomb repulsion + spring attraction + centering
 * gravity with velocity damping. Interactions: drag nodes, zoom buttons,
 * click a node to re-center (onSelect). Data: /knowledge/kg/subgraph.
 */
import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { KgSubgraphEdge, KgSubgraphNode } from "@/lib/api";

export const TYPE_COLORS: Record<string, string> = {
    person: "#af52de",
    org: "#5856d6",
    concept: "#0071e3",
    tech: "#0a84ff",
    tool: "#30b0c7",
    book: "#ff9f0a",
    event: "#ff453a",
    method: "#34c759",
    place: "#8e8e93",
    other: "#8e8e93",
};

interface SimNode extends KgSubgraphNode {
    x: number;
    y: number;
    vx: number;
    vy: number;
}

interface SimEdge {
    src: number;
    dst: number;
}

interface Props {
    nodes: KgSubgraphNode[];
    edges: KgSubgraphEdge[];
    centerEid: string | null;
    selectedEid: string | null;
    onSelect: (eid: string) => void;
    height?: number;
}

const REPULSION = 2400;
const SPRING_LEN = 110;
const SPRING_K = 0.06;
const GRAVITY = 0.02;
const DAMPING = 0.85;
const MAX_VELOCITY = 30;

function initLayout(nodes: KgSubgraphNode[], height: number): SimNode[] {
    const W = 900;
    const H = Math.max(height, 400);
    return nodes.map((n, i) => {
        if (nodes.length === 1) {
            return { ...n, x: W / 2, y: H / 2, vx: 0, vy: 0 };
        }
        const angle = (i / nodes.length) * Math.PI * 2;
        const radius = Math.min(W, H) * 0.32;
        return {
            ...n,
            x: W / 2 + radius * Math.cos(angle),
            y: H / 2 + radius * Math.sin(angle),
            vx: 0,
            vy: 0,
        };
    });
}

/** One physics step: repulsion + springs + gravity + damping. Returns a new array. */
function tick(prev: SimNode[], edges: SimEdge[]): SimNode[] {
    const next = prev.map((n) => ({ ...n }));
    const nCount = next.length;
    if (nCount === 0) return next;

    for (let i = 0; i < nCount; i++) {
        for (let j = i + 1; j < nCount; j++) {
            const a = next[i];
            const b = next[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 1) {
                dx = (Math.random() - 0.5) * 2;
                dy = (Math.random() - 0.5) * 2;
                distSq = 4;
            }
            const f = REPULSION / distSq;
            const dist = Math.sqrt(distSq);
            const fx = (dx / dist) * f;
            const fy = (dy / dist) * f;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
        }
    }
    for (const e of edges) {
        const a = next[e.src];
        const b = next[e.dst];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (dist - SPRING_LEN) * SPRING_K;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
    }
    for (const n of next) {
        n.vx += (450 - n.x) * GRAVITY;
        n.vy += (Math.max(400, 300) - n.y) * GRAVITY * 0.5;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x += Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vx));
        n.y += Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vy));
    }
    return next;
}

export function ForceGraph({
    nodes,
    edges,
    centerEid,
    selectedEid,
    onSelect,
    height = 560,
}: Props) {
    // Derive during render: reset layout when the node signature changes
    const sig = `${height}|${nodes.map((n) => n.eid).join(",")}`;
    const [layoutSig, setLayoutSig] = useState(sig);
    const [simNodes, setSimNodes] = useState<SimNode[]>(() =>
        initLayout(nodes, height),
    );
    if (sig !== layoutSig) {
        setLayoutSig(sig);
        setSimNodes(initLayout(nodes, height));
    }

    // Edge indexing: recomputed per frame by the physics loop via dataRef;
    const dataRef = useRef({ edges });
    useEffect(() => {
        dataRef.current = { edges };
    });

    const rafRef = useRef<number>(0);
    useEffect(() => {
        if (simNodes.length === 0) return;
        let running = true;
        const step = () => {
            if (!running) return;
            setSimNodes((prev) => {
                const idx = new Map(prev.map((n, i) => [n.eid, i]));
                const eIdx = dataRef.current.edges
                    .map((e) => ({
                        src: idx.get(e.src) ?? -1,
                        dst: idx.get(e.dst) ?? -1,
                    }))
                    .filter((e) => e.src >= 0 && e.dst >= 0);
                return tick(prev, eIdx);
            });
            rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
        return () => {
            running = false;
            cancelAnimationFrame(rafRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- loop is driven by the layout signature
    }, [layoutSig]);

    // Render-time derived edge indices (independent of the physics loop)
    const indexMap = new Map(simNodes.map((n, i) => [n.eid, i]));
    const simEdges = edges
        .map((e) => ({ src: indexMap.get(e.src) ?? -1, dst: indexMap.get(e.dst) ?? -1 }))
        .filter((e) => e.src >= 0 && e.dst >= 0);

    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const draggingRef = useRef<number | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    const toWorld = (clientX: number, clientY: number) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        return {
            x: (clientX - rect.left - view.x) / view.k,
            y: (clientY - rect.top - view.y) / view.k,
        };
    };

    const maxDeg = Math.max(1, ...simNodes.map((n) => n.degree));
    const nodeR = (deg: number) => 8 + (deg / maxDeg) * 14;

    return (
        <div
            className="relative overflow-hidden rounded-2xl border border-border-subtle bg-surface"
            style={{ height }}
        >
            <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={`0 0 900 ${Math.max(height, 400)}`}
                onPointerMove={(ev) => {
                    const i = draggingRef.current;
                    if (i === null) return;
                    const p = toWorld(ev.clientX, ev.clientY);
                    setSimNodes((prev) =>
                        prev.map((n, j) =>
                            j === i ? { ...n, x: p.x, y: p.y, vx: 0, vy: 0 } : n,
                        ),
                    );
                }}
                onPointerUp={() => {
                    draggingRef.current = null;
                }}
                className="touch-none select-none"
            >
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                    {simEdges.map((e, i) => {
                        const a = simNodes[e.src];
                        const b = simNodes[e.dst];
                        if (!a || !b) return null;
                        const highlighted =
                            selectedEid === a.eid || selectedEid === b.eid;
                        return (
                            <line
                                key={i}
                                x1={a.x}
                                y1={a.y}
                                x2={b.x}
                                y2={b.y}
                                stroke={highlighted ? "#0071e3" : "#d2d2d7"}
                                strokeOpacity={highlighted ? 0.9 : 0.55}
                                strokeWidth={highlighted ? 2 : 1}
                            />
                        );
                    })}
                    {simNodes.map((n, i) => {
                        const isSel = n.eid === selectedEid;
                        const isCenter = n.eid === centerEid;
                        const r = nodeR(n.degree);
                        return (
                            <g
                                key={n.eid}
                                transform={`translate(${n.x},${n.y})`}
                                className="cursor-pointer"
                                onPointerDown={(ev) => {
                                    ev.stopPropagation();
                                    (ev.target as Element).setPointerCapture(ev.pointerId);
                                    draggingRef.current = i;
                                }}
                                onClick={() => onSelect(n.eid)}
                            >
                                <circle
                                    r={r + (isSel || isCenter ? 4 : 0)}
                                    fill={TYPE_COLORS[n.type] ?? TYPE_COLORS.other}
                                    stroke={isSel || isCenter ? "#0071e3" : "#ffffff"}
                                    strokeWidth={isSel || isCenter ? 2.5 : 1.5}
                                />
                                {(n.degree >= maxDeg * 0.25 || isSel || isCenter) && (
                                    <text
                                        y={r + 13}
                                        textAnchor="middle"
                                        fontSize={11}
                                        fill="#1d1d1f"
                                        style={{ pointerEvents: "none" }}
                                    >
                                        {n.name.length > 12
                                            ? `${n.name.slice(0, 12)}…`
                                            : n.name}
                                    </text>
                                )}
                            </g>
                        );
                    })}
                </g>
            </svg>

            <div className="absolute right-3 top-3 flex flex-col gap-1.5">
                <ZoomBtn
                    label={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.25) }))}
                />
                <ZoomBtn
                    label={<Minus className="h-3.5 w-3.5" />}
                    onClick={() => setView((v) => ({ ...v, k: Math.max(0.35, v.k / 1.25) }))}
                />
                <ZoomBtn
                    label={<Maximize2 className="h-3.5 w-3.5" />}
                    onClick={() => setView({ x: 0, y: 0, k: 1 })}
                />
            </div>

            <div className="absolute bottom-3 left-3 flex max-w-[80%] flex-wrap gap-x-3 gap-y-1 rounded-xl bg-white/90 px-3 py-2 text-[10px] text-secondary shadow-sm">
                {Object.entries(TYPE_COLORS).slice(0, 9).map(([t, c]) => (
                    <span key={t} className="inline-flex items-center gap-1">
                        <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: c }}
                        />
                        {t}
                    </span>
                ))}
            </div>
        </div>
    );
}

function ZoomBtn({ label, onClick }: { label: React.ReactNode; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="grid h-7 w-7 place-items-center rounded-lg border border-border-subtle bg-white text-secondary shadow-sm hover:text-foreground"
        >
            {label}
        </button>
    );
}
