"use client";

/**
 * Reasoning-effort "rheostat" rendered inside the model picker popover.
 *
 * Drag is continuous (thumb follows the pointer at any position), then snaps
 * to one of the four stops on release with a soft spring-like CSS transition.
 * Labels are clickable and the rail supports arrow keys.
 */
import { useCallback, useRef, useState } from "react";

export type ReasoningEffort = "min" | "mid" | "high" | "max";

const LEVELS: ReasoningEffort[] = ["min", "mid", "high", "max"];

export function EffortSlider({
    value,
    onChange,
}: {
    value: ReasoningEffort;
    onChange: (value: ReasoningEffort) => void;
}) {
    const railRef = useRef<HTMLDivElement>(null);
    const [dragPos, setDragPos] = useState<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const activeIndex = Math.max(0, LEVELS.indexOf(value));
    const pos = dragPos ?? activeIndex;
    const pct = (pos / (LEVELS.length - 1)) * 100;

    const positionFromClientX = useCallback((clientX: number) => {
        const rail = railRef.current;
        if (!rail) return 0;
        const rect = rail.getBoundingClientRect();
        const raw = ((clientX - rect.left) / Math.max(1, rect.width)) * (LEVELS.length - 1);
        return Math.min(LEVELS.length - 1, Math.max(0, raw));
    }, []);

    const commit = useCallback(
        (next: number) => {
            const snapped = LEVELS[Math.round(next)];
            if (snapped && snapped !== value) onChange(snapped);
        },
        [onChange, value]
    );

    return (
        <div>
            <div
                ref={railRef}
                role="slider"
                tabIndex={0}
                aria-label="推理强度"
                aria-valuemin={0}
                aria-valuemax={LEVELS.length - 1}
                aria-valuenow={activeIndex}
                aria-valuetext={value}
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging(true);
                    setDragPos(positionFromClientX(event.clientX));
                }}
                onPointerMove={(event) => {
                    if (!dragging) return;
                    setDragPos(positionFromClientX(event.clientX));
                }}
                onPointerUp={(event) => {
                    if (!dragging) return;
                    const next = positionFromClientX(event.clientX);
                    setDragging(false);
                    setDragPos(null);
                    commit(next);
                }}
                onPointerCancel={() => {
                    setDragging(false);
                    setDragPos(null);
                }}
                onKeyDown={(event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                        event.preventDefault();
                        onChange(LEVELS[Math.max(0, activeIndex - 1)]);
                    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                        event.preventDefault();
                        onChange(LEVELS[Math.min(LEVELS.length - 1, activeIndex + 1)]);
                    }
                }}
                className="relative h-6 cursor-pointer touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-full"
            >
                <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[#e9e9ec]" />
                <div
                    className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[#0d0d0d]"
                    style={{
                        width: `${pct}%`,
                        transition: dragging ? "none" : "width 240ms cubic-bezier(0.22, 1, 0.36, 1)",
                    }}
                />
                {LEVELS.map((level, index) => (
                    <span
                        key={level}
                        aria-hidden="true"
                        className="absolute top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70"
                        style={{ left: `${(index / (LEVELS.length - 1)) * 100}%` }}
                    />
                ))}
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border border-[#d2d2d7] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
                    style={{
                        left: `calc(${pct}% - 7px)`,
                        transform: `translateY(-50%) scale(${dragging ? 1.18 : 1})`,
                        transition: dragging
                            ? "transform 120ms ease-out"
                            : "left 240ms cubic-bezier(0.22, 1, 0.36, 1), transform 160ms ease-out",
                    }}
                />
            </div>

            <div className="mt-1 flex items-center justify-between">
                {LEVELS.map((level) => (
                    <button
                        key={level}
                        type="button"
                        onClick={() => onChange(level)}
                        className={`rounded px-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                            level === value
                                ? "text-foreground"
                                : "text-tertiary hover:text-secondary"
                        }`}
                    >
                        {level}
                    </button>
                ))}
            </div>
        </div>
    );
}
