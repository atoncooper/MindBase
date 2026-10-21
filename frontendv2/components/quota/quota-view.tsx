"use client";

/**
 * QuotaView - 用量与额度详情页（Google Account 风格）。
 *
 * 设计参照 myaccount.google.com / Google Console 的视觉语言：
 *   页面底 #f8f9fa；白卡 + #dadce0 描边 + 12px 圆角；主色 #0b57d0；
 *   正文 #202124 / 次要 #5f6368；细进度条（4px）；40px 圆形图标底；
 *   胶囊按钮；双列卡片栅格（md 断点）。
 *
 * 数据源：GET /quota/summary（X-Uid 网关注入；匿名按 IP 桶）。
 */
import { useCallback, useEffect, useState } from "react";
import { BarChart3, Coins, Gauge, RefreshCw, ShieldAlert, Sparkles, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { quotaApi, type QuotaKindSummary, type QuotaSummary } from "@/lib/api";

const C = {
  blue: "#0b57d0",
  blueBg: "#e8f0fe",
  green: "#188038",
  greenBg: "#e6f4ea",
  amber: "#ea8600",
  amberBg: "#fef7e0",
  red: "#d93025",
  redBg: "#fce8e6",
  text: "#202124",
  text2: "#5f6368",
  border: "#dadce0",
  line: "#e8eaed",
  pageBg: "#f8f9fa",
};

const KIND_LABELS: Record<string, string> = {
    chat: "AI 问答",
    chat_anon: "AI 问答（未登录）",
    chat_images: "聊天图片附件",
    generate: "出题（批）",
    grade: "批改",
    kg_build: "知识图谱构建",
    vectorize: "视频向量化（分P）",
    ocr: "OCR 识别",
    board: "AI 补全",
};

function formatYuan(microYuan: number): string {
    const yuan = microYuan / 1e6;
    return `¥${yuan < 0.01 && yuan > 0 ? yuan.toFixed(4) : yuan.toFixed(2)}`;
}

function formatCountdown(resetAt: number): string {
    const remaining = Math.max(0, resetAt - Date.now());
    const h = Math.floor(remaining / 3600_000);
    const m = Math.floor((remaining % 3600_000) / 60_000);
    if (h <= 0 && m <= 0) return "即将重置";
    return h > 0 ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`;
}

/** Google 式卡片：白底 + 描边 + 12px 圆角。 */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div
            className={cn("rounded-xl bg-white p-5", className)}
            style={{ border: `1px solid ${C.border}` }}
        >
            {children}
        </div>
    );
}

/** 卡片小节标题：40px 圆形图标底 + 16px 标题（Google Account 惯例）。 */
function CardTitle({ icon, title, right }: { icon: React.ReactNode; title: string; right?: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
                <span
                    className="flex h-10 w-10 items-center justify-center rounded-full"
                    style={{ background: C.blueBg, color: C.blue }}
                >
                    {icon}
                </span>
                <h2 className="text-base font-medium" style={{ color: C.text }}>
                    {title}
                </h2>
            </div>
            {right}
        </div>
    );
}

function KindRow({ kind, first }: { kind: QuotaKindSummary; first: boolean }) {
    const label = KIND_LABELS[kind.kind] ?? kind.kind;
    const unlimited = kind.limit < 0;
    const ratio = unlimited ? 0 : kind.limit > 0 ? kind.used / kind.limit : 1;
    const barColor = ratio >= 1 ? C.red : ratio >= 0.8 ? C.amber : C.blue;
    const width = `${Math.min(100, Math.round(ratio * 100))}%`;
    return (
        <div className={cn("py-3", !first && "border-t")} style={{ borderColor: C.line }}>
            <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium" style={{ color: C.text }}>{label}</span>
                <span className="text-xs tabular-nums" style={{ color: ratio >= 1 ? C.red : C.text2 }}>
                    {unlimited ? "不限量" : `${kind.used} / ${kind.limit}`}
                </span>
            </div>
            {!unlimited && (
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: C.line }}>
                    <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ background: barColor, width: kind.used > 0 ? width : "0%" }}
                    />
                </div>
            )}
        </div>
    );
}

export function QuotaView() {
    const [summary, setSummary] = useState<QuotaSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setSummary(await quotaApi.getSummary());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // 重置倒计时每分钟走一格
    const [, tick] = useState(0);
    useEffect(() => {
        const id = window.setInterval(() => tick((t) => t + 1), 60_000);
        return () => window.clearInterval(id);
    }, []);

    // 主 kind = 与当前身份相关的那一条：登录者取 chat，未登录取 chat_anon
    const chatKind =
      summary?.kinds.find((k) => k.kind === "chat") ?? summary?.kinds.find((k) => k.kind === "chat_anon");
    const chatLabel = chatKind ? KIND_LABELS[chatKind.kind] ?? "AI 问答" : "AI 问答";
    const chatRatio = chatKind && chatKind.limit > 0 ? Math.min(100, Math.round((chatKind.used / chatKind.limit) * 100)) : 0;
    const chatBar = chatRatio >= 100 ? C.red : chatRatio >= 80 ? C.amber : C.blue;

    return (
        <div
        className="mx-auto min-h-[calc(100dvh-3rem-3.75rem-env(safe-area-inset-bottom))] max-w-[960px] px-5 py-8 md:min-h-[calc(100vh-3rem)]"
        style={{ background: C.pageBg }}
      >
            {/* 页头：标题 + 刷新（Google 式圆形 icon button） */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-medium" style={{ color: C.text }}>用量与额度</h1>
                    <p className="mt-1 text-sm" style={{ color: C.text2 }}>
                        {summary ? formatCountdown(summary.cost.resetAt) : "加载中…"} · 每日 0 点重置（Asia/Shanghai）
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void refresh()}
                    className="flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-[#f1f3f4]"
                    style={{ color: C.text2 }}
                    aria-label="刷新用量"
                >
                    <RefreshCw className={cn("h-5 w-5", loading && "animate-spin")} />
                </button>
            </div>

            {error && (
                <Card className="mt-5">
                    <div className="flex items-start gap-3">
                        <ShieldAlert className="mt-0.5 h-5 w-5" style={{ color: C.red }} />
                        <div>
                            <p className="text-sm font-medium" style={{ color: C.text }}>用量加载失败</p>
                            <p className="mt-1 text-xs" style={{ color: C.text2 }}>{error}（接口 /quota/summary 不可达？）</p>
                        </div>
                    </div>
                </Card>
            )}

            {summary && !summary.enabled && (
                <Card className="mt-5">
                    <p className="text-sm" style={{ color: C.text2 }}>
                        用量统计未启用（quota.enabled=false），当前不限量。
                    </p>
                </Card>
            )}

            {summary && summary.enabled && summary.tierSource === "fallback" && (
                <Card className="mt-5">
                    <div className="flex items-start gap-3">
                        <ShieldAlert className="mt-0.5 h-5 w-5" style={{ color: C.amber }} />
                        <div>
                            <p className="text-sm font-medium" style={{ color: C.text }}>
                                会员权益同步失败，当前按免费档展示
                            </p>
                            <p className="mt-1 text-xs" style={{ color: C.text2 }}>
                                你的会员档位暂时无法从支付服务确认（网络或内部鉴权异常）。额度将在恢复后自动按会员档位生效；
                                若持续出现，请联系管理员检查 app-pay 服务连接与网关内部密钥配置。
                            </p>
                        </div>
                    </div>
                </Card>
            )}

            {summary && summary.enabled && (
                <>
                    {/* 第一行：今日概览 + 今日成本（双列栅格） */}
                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                        <Card>
                            <CardTitle icon={<Gauge className="h-5 w-5" />} title="今日概览" />
                            <div className="mt-4 flex items-baseline gap-2">
                                <span className="text-4xl font-normal tabular-nums" style={{ color: C.blue }}>
                                    {chatKind?.used ?? 0}
                                </span>
                                <span className="text-sm" style={{ color: C.text2 }}>
                                    / {chatKind?.limit ?? "-"} 条 {chatLabel}
                                </span>
                            </div>
                            <div className="mt-3 h-1 w-full overflow-hidden rounded-full" style={{ background: C.line }}>
                                <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{ background: chatBar, width: `${chatRatio}%` }}
                                />
                            </div>
                            <p className="mt-3 text-xs" style={{ color: C.text2 }}>
                                {formatCountdown(summary.cost.resetAt)} · 剩余 {Math.max(0, (chatKind?.limit ?? 0) - (chatKind?.used ?? 0))} 条
                            </p>
                        </Card>

                        <Card>
                            <CardTitle
                                icon={<Coins className="h-5 w-5" />}
                                title="今日成本"
                                right={
                                    summary.cost.level === "L1" ? (
                                        <span
                                            className="rounded-full px-2.5 py-1 text-xs font-medium"
                                            style={{ background: C.amberBg, color: C.amber }}
                                        >
                                            省流模式
                                        </span>
                                    ) : undefined
                                }
                            />
                            <div className="mt-4 space-y-3">
                                {[
                                    { label: "已产生", value: formatYuan(summary.cost.microYuan), hint: "全能力合计" },
                                    { label: "省流阈值", value: summary.cost.softMicroYuan > 0 ? formatYuan(summary.cost.softMicroYuan) : "—", hint: "超过后进入 L1" },
                                    { label: "熔断阈值", value: formatYuan(summary.cost.guardMicroYuan), hint: summary.cost.guardEnabled ? "超过当日冻结" : "未启用" },
                                ].map((row) => (
                                    <div key={row.label} className="flex items-center justify-between border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: C.line }}>
                                        <div>
                                            <div className="text-sm" style={{ color: C.text }}>{row.label}</div>
                                            <div className="text-xs" style={{ color: C.text2 }}>{row.hint}</div>
                                        </div>
                                        <div className="text-lg font-normal tabular-nums" style={{ color: C.text }}>{row.value}</div>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </div>

                    {/* 第二行：各能力用量（全宽列表卡） */}
                    <Card className="mt-4">
                        <CardTitle icon={<BarChart3 className="h-5 w-5" />} title="各能力用量" />
                        <div className="mt-2">
                            {summary.kinds.map((k, i) => (
                                <KindRow key={k.kind} kind={k} first={i === 0} />
                            ))}
                        </div>
                    </Card>

                    {/* 第三行：升级引导（Google 式 outlined 卡 + 填充胶囊按钮） */}
                    {summary.tier !== "svip" && (
                        <Card className="mt-4">
                            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                                <div className="flex items-center gap-3">
                                    <span
                                        className="flex h-10 w-10 items-center justify-center rounded-full"
                                        style={{ background: C.amberBg, color: "#b06000" }}
                                    >
                                        <Sparkles className="h-5 w-5" />
                                    </span>
                                    <div>
                                        <div className="text-sm font-medium" style={{ color: C.text }}>
                                            升级到 {summary.tier === "free" ? "VIP" : "SVIP"}
                                        </div>
                                        <div className="text-xs" style={{ color: C.text2 }}>
                                            更高每日额度 · 会员优先队列 · 云盘 100GiB / 1TiB
                                        </div>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => (window.location.href = "/membership")}
                                    className="rounded-full px-5 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
                                    style={{ background: C.blue }}
                                >
                                    升级会员
                                </button>
                            </div>
                        </Card>
                    )}

                    {/* 页脚说明（Google 式小字注脚） */}
                    <p className="mt-4 text-xs" style={{ color: C.text2 }}>
                        <TrendingUp className="mr-1 inline h-3 w-3" />
                        配额为滚动自然日口径（0 点重置）；「成功才计数」——失败与重试不消耗额度。成本按写入时价格快照折算，仅供参考。
                    </p>
                </>
            )}
        </div>
    );
}
