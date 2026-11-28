"use client";

/**
 * 推理强度滑动条（连续 0–100，Codex 风格彩色轨道）。
 *
 * - 自由拖动、无吸附档位：0 = 最轻（绿色），100 = 最强（紫色），沿途经
 *   黄绿 → 琥珀 → 珊瑚 → 紫色渐变；
 * - 轨道只绘制到滑块位置（右侧为灰色底），滑块为白色圆点 + 阴影；
 * - 支持键盘：←/→（±1，Shift ±5）、PageUp/PageDown（±10）、Home/End；
 * - 值经 localStorage 持久化（见 chat-view），发送给 /chat 的 reasoning_effort
 *   为 0–100 的数字；后端再映射到网关支持的枚举。
 */
import { useCallback, useRef, useState } from "react";

/** 0–100 的连续推理强度。 */
export type ReasoningEffort = number;

export const REASONING_EFFORT_MIN = 0;
export const REASONING_EFFORT_MAX = 100;
/** 默认值：与旧版四档里的 mid 区间一致（后端映射为 low）。 */
export const REASONING_EFFORT_DEFAULT = 50;

/** 旧版四档标签 → 新数值（读取历史 localStorage / 兼容旧请求时使用）。 */
export const LEGACY_EFFORT_STOPS: Record<string, number> = {
    min: 0,
    mid: 33,
    high: 66,
    max: 100,
};

export function clampReasoningEffort(value: number): number {
    if (!Number.isFinite(value)) return REASONING_EFFORT_DEFAULT;
    return Math.min(REASONING_EFFORT_MAX, Math.max(REASONING_EFFORT_MIN, Math.round(value)));
}

/** 连续值 → 可读档位名（与后端 bucket 边界对齐）。 */
export function reasoningEffortLabel(value: number): string {
    const v = clampReasoningEffort(value);
    if (v < 30) return "轻";
    if (v < 55) return "平衡";
    if (v < 80) return "强";
    return "极强";
}

/** 轨道渐变：绿（最轻）→ 黄绿 → 琥珀 → 珊瑚 → 紫（最强）。 */
const TRACK_GRADIENT =
    "linear-gradient(90deg, #34c759 0%, #a3e635 20%, #ffd60a 42%, #ff9f0a 62%, #ff375f 80%, #bf5af2 100%)";

export function EffortSlider({
    value,
    onChange,
}: {
    value: ReasoningEffort;
    onChange: (value: ReasoningEffort) => void;
}) {
    const railRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const pct = (clampReasoningEffort(value) / REASONING_EFFORT_MAX) * 100;

    const valueFromClientX = useCallback((clientX: number): number => {
        const rail = railRef.current;
        if (!rail) return value;
        const rect = rail.getBoundingClientRect();
        const ratio = (clientX - rect.left) / Math.max(1, rect.width);
        return clampReasoningEffort(ratio * REASONING_EFFORT_MAX);
    }, [value]);

    const emit = useCallback(
        (next: number) => {
            const clamped = clampReasoningEffort(next);
            if (clamped !== value) onChange(clamped);
        },
        [onChange, value]
    );

    return (
        <div className="select-none">
            <div
                ref={railRef}
                role="slider"
                tabIndex={0}
                aria-label="推理强度"
                aria-valuemin={REASONING_EFFORT_MIN}
                aria-valuemax={REASONING_EFFORT_MAX}
                aria-valuenow={clampReasoningEffort(value)}
                aria-valuetext={`${reasoningEffortLabel(value)} ${clampReasoningEffort(value)}`}
                onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging(true);
                    emit(valueFromClientX(event.clientX));
                }}
                onPointerMove={(event) => {
                    if (!dragging) return;
                    emit(valueFromClientX(event.clientX));
                }}
                onPointerUp={(event) => {
                    if (!dragging) return;
                    emit(valueFromClientX(event.clientX));
                    setDragging(false);
                }}
                onPointerCancel={() => setDragging(false)}
                onKeyDown={(event) => {
                    const current = clampReasoningEffort(value);
                    const step = event.shiftKey ? 5 : 1;
                    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                        event.preventDefault();
                        emit(current - step);
                    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                        event.preventDefault();
                        emit(current + step);
                    } else if (event.key === "PageDown") {
                        event.preventDefault();
                        emit(current - 10);
                    } else if (event.key === "PageUp") {
                        event.preventDefault();
                        emit(current + 10);
                    } else if (event.key === "Home") {
                        event.preventDefault();
                        emit(REASONING_EFFORT_MIN);
                    } else if (event.key === "End") {
                        event.preventDefault();
                        emit(REASONING_EFFORT_MAX);
                    }
                }}
                className="relative h-7 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            >
                {/* 轨道底色 */}
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#e9e9ec]" />
                {/* 渐变轨道：只绘制到当前值（clip 而不是压缩渐变，保证颜色与位置对应） */}
                <div
                    aria-hidden="true"
                    className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                    style={{
                        background: TRACK_GRADIENT,
                        clipPath: `inset(0 ${100 - pct}% 0 0 round 9999px)`,
                        WebkitClipPath: `inset(0 ${100 - pct}% 0 0 round 9999px)`,
                    }}
                />
                {/* 白色滑块 + 柔和阴影 */}
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full border border-black/10 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.22),0_0_0_0.5px_rgba(0,0,0,0.04)]"
                    style={{
                        left: `calc(${pct}% - 9px)`,
                        transform: `translateY(-50%) scale(${dragging ? 1.15 : 1})`,
                        transition: dragging
                            ? "transform 120ms ease-out"
                            : "left 120ms ease-out, transform 160ms ease-out",
                    }}
                />
            </div>

            {/* 两端语义标签：左轻（绿）/ 右强（紫） */}
            <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] font-medium" style={{ color: "#34c759" }}>
                    轻
                </span>
                <span className="text-[10px] font-medium" style={{ color: "#bf5af2" }}>
                    强
                </span>
            </div>
        </div>
    );
}
