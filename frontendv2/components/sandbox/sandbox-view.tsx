"use client";

/**
 * SandboxView - 沙箱执行面板（run_code）。
 *
 * 数据源：GET /chat/sandbox/executions（app-ts 代理 app-sandbox，契约见
 * docs/research-ui-api.md §7）。三条状态：
 *   - enabled=false：部署未开启沙箱，展示未启用提示（不报错）；
 *   - 空列表：还没有执行记录；
 *   - 有记录：按新到旧渲染卡片，running/queued 时每 5 秒静默轮询一次。
 *
 * 请求一律经 lib/api/sandbox.ts，组件不直接 fetch。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, SquareTerminal } from "lucide-react";
import { sandboxApi, type SandboxExecution } from "@/lib/api";
import { EmptyState, ErrorBanner, LoadingBlock, SurfaceCard } from "@/components/research/research-ui";
import { cn } from "@/lib/utils";
import { ExecutionCard } from "./execution-card";

/** 有排队/运行中执行时的静默刷新间隔。 */
const POLL_INTERVAL_MS = 5000;
/** 与服务端契约一致的默认条数（服务端上限 50）。 */
const DEFAULT_LIMIT = 20;

export function SandboxView() {
    const [executions, setExecutions] = useState<SandboxExecution[]>([]);
    const [enabled, setEnabled] = useState(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cancellingId, setCancellingId] = useState<string | null>(null);
    // 轮询/手动刷新共用同一把锁：上一次请求未回来时不再叠加请求。
    const inflight = useRef(false);

    // 静默刷新（轮询 / 手动刷新 / 取消后回读共用）。setState 都发生在 await
    // 之后，因此在事件处理器与定时器回调里调用不会触发同步级联渲染。
    const load = useCallback(async () => {
        if (inflight.current) return;
        inflight.current = true;
        try {
            const data = await sandboxApi.listExecutions(DEFAULT_LIMIT);
            // enabled 缺省按 true 处理，兼容尚未升级的 app-ts 代理。
            setEnabled(data.enabled !== false);
            setExecutions(data.executions ?? []);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "加载沙箱执行记录失败");
        } finally {
            inflight.current = false;
            setLoading(false);
        }
    }, []);

    // 首屏加载：effect 内直接发起请求，且只在 await 之后 setState（满足
    // react-hooks/set-state-in-effect，避免同步级联渲染）。
    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                const data = await sandboxApi.listExecutions(DEFAULT_LIMIT);
                if (!active) return;
                setEnabled(data.enabled !== false);
                setExecutions(data.executions ?? []);
                setError(null);
            } catch (err) {
                if (!active) return;
                setError(err instanceof Error ? err.message : "加载沙箱执行记录失败");
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, []);

    const hasActive = executions.some((item) => !item.done);
    useEffect(() => {
        if (!enabled || !hasActive) return;
        const timer = window.setInterval(() => {
            void load();
        }, POLL_INTERVAL_MS);
        // 组件卸载 / 进入终态即清理定时器，避免泄漏与无意义请求。
        return () => window.clearInterval(timer);
    }, [enabled, hasActive, load]);

    // 重试在事件处理器里重置加载态（effect 里不允许同步 setState）。
    const handleRetry = useCallback(() => {
        if (inflight.current) return;
        setLoading(true);
        setError(null);
        void load();
    }, [load]);

    const handleCancel = useCallback(
        async (executionId: string) => {
            setCancellingId(executionId);
            setError(null);
            try {
                await sandboxApi.cancelExecution(executionId);
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "取消执行失败");
            } finally {
                setCancellingId(null);
            }
        },
        [load],
    );

    const showDisabled = !loading && !enabled;
    const showEmpty = !loading && enabled && !error && executions.length === 0;

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8 sm:px-10">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-[22px] font-semibold tracking-tight text-foreground">沙箱</h1>
                    <p className="mt-1 text-[12px] text-secondary">
                        agent 通过 run_code 发起的代码执行记录（状态 / 输出预览 / 产物）；运行中的任务每 5 秒自动刷新。
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void load()}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                >
                    <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                    刷新
                </button>
            </header>

            {error && (
                <div className="mt-4">
                    <ErrorBanner message={error} onRetry={handleRetry} />
                </div>
            )}

            <div className="mt-5">
                {loading ? (
                    <LoadingBlock label="加载执行记录…" />
                ) : showDisabled ? (
                    <SurfaceCard>
                        <EmptyState
                            icon={SquareTerminal}
                            title="沙箱未启用"
                            description="当前部署未开启沙箱执行能力（sandbox.enabled=false）。开启后，agent 运行代码的记录会显示在这里。"
                        />
                    </SurfaceCard>
                ) : showEmpty ? (
                    <SurfaceCard>
                        <EmptyState
                            icon={SquareTerminal}
                            title="还没有执行记录"
                            description="当 agent 在科研工作台等场景运行代码时，执行状态、输出预览与产物会显示在这里。"
                        />
                    </SurfaceCard>
                ) : (
                    <div className="space-y-3">
                        {executions.map((execution) => (
                            <ExecutionCard
                                key={execution.executionId}
                                execution={execution}
                                cancelling={cancellingId === execution.executionId}
                                onCancel={handleCancel}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
