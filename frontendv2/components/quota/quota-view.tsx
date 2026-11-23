"use client";

/**
 * QuotaView - 用量与额度详情页（Google Account 风格）。
 *
 * 数据源：GET /quota/summary。额度按 Credits 计量（Codex 风格），
 * 三层窗口：滚动 5 小时 + 自然日 + 自然月；不同模型按单价折算抵扣倍率。
 */
import { useCallback, useEffect, useState } from "react";
import { BarChart3, CalendarDays, Clock3, Coins, Gauge, Info, RefreshCw, ShieldAlert, Sparkles, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { quotaApi, type QuotaKindSummary, type QuotaModelRate, type QuotaSummary, type QuotaWindow, type QuotaWindowState } from "@/lib/api";

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
  generate: "出题",
  grade: "批改",
  kg_build: "知识图谱构建",
  vectorize: "视频向量化",
  ocr: "OCR 识别",
  board: "AI 补全",
  academic_analysis: "科研分析",
  academic_validation: "学术校验",
  academic_export: "导出/投稿包",
  academic_experiment: "后台实验",
};

const WINDOW_META: Record<QuotaWindow, { label: string; hint: string }> = {
  five_hour: { label: "5 小时滚动", hint: "最早用量 5 小时后滚出" },
  day: { label: "今日", hint: "每日 0 点重置" },
  month: { label: "本月", hint: "每月 1 日 0 点重置" },
};

function formatTokens(tokens: number): string {
  if (tokens < 0) return "不限";
  if (!Number.isFinite(tokens)) return "0";
  if (tokens >= 100_000_000) return (tokens / 100_000_000).toFixed(2) + " 亿";
  if (tokens >= 10_000) {
    const wan = tokens / 10_000;
    return (wan >= 1_000 ? Math.round(wan) : Math.round(wan * 10) / 10) + " 万";
  }
  return Math.max(0, Math.round(tokens)).toLocaleString("zh-CN");
}

function formatWeight(weight: number): string {
  if (!Number.isFinite(weight) || weight <= 0) return "—";
  if (weight < 0.01) return weight.toFixed(4);
  if (weight < 1) return weight.toFixed(2);
  return weight.toFixed(1);
}

function formatYuan(microYuan: number): string {
  const yuan = microYuan / 1e6;
  return `¥${yuan < 0.01 && yuan > 0 ? yuan.toFixed(4) : yuan.toFixed(2)}`;
}

function formatCountdown(resetAt: number): string {
  const remaining = Math.max(0, resetAt - Date.now());
  const h = Math.floor(remaining / 3600_000);
  const m = Math.floor((remaining % 3600_000) / 60_000);
  if (h <= 0 && m <= 0) return "即将重置";
  return h > 0 ? `${h} 小时 ${m} 分后` : `${m} 分钟后`;
}

function formatResetAt(resetAt: number): string {
  const d = new Date(resetAt);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Google 式卡片：白底 + 描边 + 12px 圆角。 */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl bg-white p-5", className)} style={{ border: `1px solid ${C.border}` }}>
      {children}
    </div>
  );
}

/** 卡片小节标题：40px 圆形图标底 + 16px 标题。 */
function CardTitle({ icon, title, right }: { icon: React.ReactNode; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: C.blueBg, color: C.blue }}>
          {icon}
        </span>
        <h2 className="text-base font-medium" style={{ color: C.text }}>{title}</h2>
      </div>
      {right}
    </div>
  );
}

function WindowCard({ state }: { state: QuotaWindowState }) {
  const meta = WINDOW_META[state.window];
  const unlimited = state.limit < 0;
  const percent = state.usedPercent ?? 0;
  const barColor = percent >= 100 ? C.red : percent >= 80 ? C.amber : C.blue;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: C.text }}>
          {state.window === "five_hour" ? <Clock3 className="h-4 w-4" style={{ color: C.blue }} /> : <CalendarDays className="h-4 w-4" style={{ color: C.blue }} />}
          {meta.label}
        </div>
        <span className="text-[11px]" style={{ color: C.text2 }}>
          {unlimited ? "不限" : `${formatTokens(state.used)} / ${formatTokens(state.limit)}`}
        </span>
      </div>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-4xl font-normal tabular-nums" style={{ color: barColor }}>
          {unlimited ? "∞" : percent}
        </span>
        {!unlimited && <span className="text-sm" style={{ color: C.text2 }}>% 已用</span>}
      </div>
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full" style={{ background: C.line }}>
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ background: barColor, width: unlimited ? "0%" : `${percent}%` }}
        />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed" style={{ color: C.text2 }}>
        {meta.hint}
        {state.window !== "five_hour" && ` · ${formatCountdown(state.resetAt)}`}
        {state.window === "five_hour" && ` · ${formatCountdown(state.resetAt)}完全滚出`}
      </p>
    </Card>
  );
}

function KindRow({ kind, first }: { kind: QuotaKindSummary; first: boolean }) {
  const label = KIND_LABELS[kind.kind] ?? kind.kind;
  const percent = kind.usedPercent ?? 0;
  const barColor = percent >= 100 ? C.red : percent >= 80 ? C.amber : C.blue;
  return (
    <div className={cn("py-3", !first && "border-t")} style={{ borderColor: C.line }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium" style={{ color: C.text }}>{label}</span>
        <span className="text-xs tabular-nums" style={{ color: C.text2 }}>
          {formatTokens(kind.used)} Credits · 占今日 {percent}%
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: C.line }}>
        <div className="h-full rounded-full" style={{ background: barColor, width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

function ModelRow({ model }: { model: QuotaModelRate }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-t py-2.5 first:border-t-0" style={{ borderColor: C.line }}>
      <span className="min-w-0 truncate font-mono text-[11px]" style={{ color: C.text }} title={model.model}>
        {model.model}
      </span>
      <span className="text-[11px] tabular-nums" style={{ color: C.text2 }}>入 ×{formatWeight(model.inputWeight)}</span>
      <span className="text-[11px] tabular-nums" style={{ color: C.text2 }}>出 ×{formatWeight(model.outputWeight)}</span>
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

  // 倒计时每分钟走一格
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const windows = summary?.windows ?? [];
  const dayWindow = windows.find((w) => w.window === "day");
  const plan = summary?.plan;
  const visibleKinds = (summary?.kinds ?? []).filter((k) => k.used > 0);
  const models = summary?.models ?? [];
  const nextTier =
    summary?.tier === "free" ? "vip"
      : summary?.tier === "vip" ? "svip"
        : summary?.tier === "svip" ? "promax"
          : null;
  const nextPlan = (summary?.planCatalog ?? []).find((p) => p.tier === nextTier);

  return (
    <div
      className="mx-auto min-h-[calc(100dvh-3rem-3.75rem-env(safe-area-inset-bottom))] max-w-[1040px] px-5 py-8 md:min-h-[calc(100vh-3rem)]"
      style={{ background: C.pageBg }}
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium" style={{ color: C.text }}>用量与额度</h1>
          <p className="mt-1 text-sm" style={{ color: C.text2 }}>
            按 Credits 计量（模型单价折算）· 5 小时滚动 / 每日 / 每月三层额度 · 所有 AI 能力共享
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
              <p className="text-sm font-medium" style={{ color: C.text }}>会员权益同步失败，当前按免费档展示</p>
              <p className="mt-1 text-xs" style={{ color: C.text2 }}>
                你的会员档位暂时无法从支付服务确认（网络或内部鉴权异常）。额度将在恢复后自动按会员档位生效。
              </p>
            </div>
          </div>
        </Card>
      )}

      {summary && summary.enabled && summary.storeUnavailable && (
        <Card className="mt-5">
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-5 w-5" style={{ color: C.amber }} />
            <p className="text-xs" style={{ color: C.text2 }}>
              额度计数服务短暂不可用，本次按 fail-open 放行展示；停止服务异常后会自动恢复精确计数。
            </p>
          </div>
        </Card>
      )}

      {summary && summary.enabled && (
        <>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {windows.map((w) => <WindowCard key={w.window} state={w} />)}
          </div>

          {plan && (
            <Card className="mt-4">
              <CardTitle
                icon={<Sparkles className="h-5 w-5" />}
                title="当前套餐额度"
                right={
                  plan.bonus > 0 ? (
                    <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: C.greenBg, color: C.green }}>
                      {plan.bonus}× 权益
                    </span>
                  ) : undefined
                }
              />
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs" style={{ color: C.text2 }}>套餐</div>
                  <div className="mt-1 text-xl font-normal tabular-nums" style={{ color: C.text }}>
                    {plan.priceYuan > 0 ? `¥${plan.priceYuan}/月` : "免费"}
                  </div>
                </div>
                <div>
                  <div className="text-xs" style={{ color: C.text2 }}>等值额度</div>
                  <div className="mt-1 text-xl font-normal tabular-nums" style={{ color: C.green }}>
                    {plan.valueYuan > 0 ? `¥${plan.valueYuan}` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs" style={{ color: C.text2 }}>月度 Credits</div>
                  <div className="mt-1 text-xl font-normal tabular-nums" style={{ color: C.text }}>
                    {formatTokens(plan.monthlyTokens)}
                  </div>
                </div>
              </div>
              <p className="mt-4 text-xs leading-relaxed" style={{ color: C.text2 }}>
                Credits 按参考价 ¥{plan.referencePricePerMTok}/百万 Credits 折算；¥{plan.priceYuan} 档包含
                ¥{plan.valueYuan} 等值用量（{plan.bonus > 0 ? plan.bonus : "—"}×）。贵模型按单价折算，扣得更快；
                便宜模型能拉长使用时间。
              </p>
            </Card>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card>
              <CardTitle icon={<BarChart3 className="h-5 w-5" />} title="今日能力分布" />
              <div className="mt-2">
                {visibleKinds.length === 0 ? (
                  <p className="py-4 text-xs" style={{ color: C.text2 }}>今日还没有 AI 用量。</p>
                ) : (
                  visibleKinds.map((k, i) => <KindRow key={k.kind} kind={k} first={i === 0} />)
                )}
              </div>
              <p className="mt-2 text-[11px]" style={{ color: C.text2 }}>
                所有能力共享同一个 Credits 池，不设单项次数上限；失败与重试不扣。
              </p>
            </Card>

            <Card>
              <CardTitle icon={<Coins className="h-5 w-5" />} title="今日成本" right={
                summary.cost.level === "L1" ? (
                  <span className="rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: C.amberBg, color: C.amber }}>
                    省流模式
                  </span>
                ) : undefined
              } />
              <div className="mt-4 space-y-3">
                {[
                  { label: "已产生", value: formatYuan(summary.cost.microYuan), hint: "全能力合计（成本账本）" },
                  { label: "成本熔断", value: summary.cost.guardEnabled ? formatYuan(summary.cost.guardMicroYuan) : "未启用", hint: "Credits 窗口之外的兜底" },
                  { label: "下次重置", value: dayWindow ? formatResetAt(dayWindow.resetAt) : "—", hint: "每日 0 点（Asia/Shanghai）" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0" style={{ borderColor: C.line }}>
                    <div>
                      <div className="text-sm" style={{ color: C.text }}>{row.label}</div>
                      <div className="text-xs" style={{ color: C.text2 }}>{row.hint}</div>
                    </div>
                    <div className="text-right text-lg font-normal tabular-nums" style={{ color: C.text }}>{row.value}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardTitle icon={<Gauge className="h-5 w-5" />} title="模型抵扣倍率" right={
              <span className="text-[11px]" style={{ color: C.text2 }}>扣减 = 输入 × 入倍率 + 输出 × 出倍率</span>
            } />
            <div className="mt-3">
              {models.map((m) => <ModelRow key={m.model} model={m} />)}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: C.text2 }}>
              倍率 1.0 = 按参考价 ¥{plan?.referencePricePerMTok ?? 10}/百万 Credits 扣减；2.0 = 同样真实调用消耗两倍 Credits。
              倍率由模型单价推导，运营可在 quota.modelWeights 覆盖。
            </p>
          </Card>

          {summary.tier !== "promax" && nextTier && (
            <Card className="mt-4">
              <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: C.amberBg, color: "#b06000" }}>
                    <Sparkles className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-sm font-medium" style={{ color: C.text }}>
                      升级到 {nextTier === "vip" ? "VIP" : nextTier === "svip" ? "SVIP" : "ProMax"}
                    </div>
                    <div className="text-xs" style={{ color: C.text2 }}>
                      更高 Credits 额度 · 会员优先队列 · 云盘容量升级
                      {nextPlan ? ` · ${formatTokens(nextPlan.monthlyTokens)} Credits/月（¥${nextPlan.valueYuan} 等值）` : ""}
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

          <p className="mt-4 text-xs leading-relaxed" style={{ color: C.text2 }}>
            <TrendingUp className="mr-1 inline h-3 w-3" />
            Credits 额度按「成功才计数」：失败与重试不消耗。5 小时窗口为滚动口径，最早用量 5 小时后自动滚出；
            每日 0 点、每月 1 日 0 点（Asia/Shanghai）重置。成本按写入时价格快照折算，仅供参考。
          </p>
        </>
      )}
    </div>
  );
}
