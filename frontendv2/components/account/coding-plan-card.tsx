"use client";

/**
 * CodingPlanCard - 账户设置里的 Coding Plan 管理卡（Google Account 风格）。
 *
 * 视觉参照 quota-view / myaccount.google.com：白卡 + #dadce0 描边 + 12px 圆角、
 * 主色 #0b57d0、正文 #202124 / 次要 #5f6368、40px 圆形图标底、4px 细进度条、
 * 胶囊按钮；不使用玻璃拟态或渐变。
 *
 * VIP/SVIP/ProMax 用户可以添加第三方编程套餐（OpenCode Zen/Go、Kimi Coding 或
 * 自定义 OpenAI/Anthropic 兼容端点），供站内对话 / Code Agent 使用；free
 * 只看到升级提示（链 /membership）。所有请求经 lib/api/coding-plan.ts，组件
 * 不直接 fetch。API Key 只写不读：列表仅展示后端返回的 api_key_masked，编辑
 * 时留空表示保持原密钥；「测试」按钮探测已保存的端点并内联展示结果。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
    AlertCircle,
    Boxes,
    Globe2,
    KeyRound,
    Loader2,
    Lock,
    Pencil,
    PlugZap,
    RefreshCw,
    Star,
    Plus,
    Sparkles,
    Trash2,
    type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import {
    codingPlanApi,
    type CodingPlan,
    type CodingPlanInput,
    type CodingPlanPatch,
    type CodingPlanProvider,
    type CodingPlanProviderInfo,
    type CodingPlanProtocol,
    type PayMembership,
    type QuotaSummary,
} from "@/lib/api";
import { formatTokens } from "./account-utils";
import { ConfirmDialog } from "@/components/confirm-dialog";


/** Google 账户色板（与 components/quota/quota-view.tsx 保持一致）。 */
const C = {
    blue: "#0b57d0",
    blueBg: "#e8f0fe",
    green: "#188038",
    greenBg: "#e6f4ea",
    amberText: "#b06000",
    amberBg: "#fef7e0",
    red: "#d93025",
    redBg: "#fce8e6",
    text: "#202124",
    text2: "#5f6368",
    border: "#dadce0",
    line: "#e8eaed",
    pageBg: "#f8f9fa",
    surface: "#ffffff",
    switchOff: "#bdc1c6",
};

const MAX_PLANS = 5;

const PROTOCOL_OPTIONS = [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "anthropic", label: "Anthropic 兼容" },
];

/** Visual-only provider mapping (icons/colors). Labels and URLs come from YAML. */
const PROVIDER_VISUALS: Record<string, { bg: string; fg: string; Icon: LucideIcon }> = {
    opencode_zen: { bg: C.blueBg, fg: C.blue, Icon: Boxes },
    opencode_go: { bg: C.blueBg, fg: C.blue, Icon: Boxes },
    opencode: { bg: C.blueBg, fg: C.blue, Icon: Boxes },
    kimi: { bg: C.greenBg, fg: C.green, Icon: Sparkles },
    glm: { bg: "rgba(124, 58, 237, 0.12)", fg: "#6d28d9", Icon: Sparkles },
    minimax: { bg: "rgba(234, 88, 12, 0.12)", fg: "#c2410c", Icon: Globe2 },
    qwen: { bg: "rgba(13, 148, 136, 0.12)", fg: "#0f766e", Icon: Globe2 },
    deepseek: { bg: "rgba(37, 99, 235, 0.12)", fg: "#1d4ed8", Icon: Sparkles },
    custom: { bg: C.amberBg, fg: C.amberText, Icon: Globe2 },
};

function providerVisual(provider: CodingPlanProvider) {
    return PROVIDER_VISUALS[provider] ?? PROVIDER_VISUALS.custom;
}

function providerLabel(provider: CodingPlanProvider, providers: CodingPlanProviderInfo[]): string {
    return providers.find((p) => p.name === provider)?.label ?? provider;
}

function providerDefaults(provider: CodingPlanProvider, providers: CodingPlanProviderInfo[]) {
    const info = providers.find((p) => p.name === provider);
    return {
        openai: info?.openai_base_url ?? "",
        anthropic: info?.anthropic_base_url ?? "",
        model: info?.model_hint ?? "",
    };
}

/** Base URL for a provider + protocol, sourced from the YAML catalog. */
function defaultBaseUrl(
    provider: CodingPlanProvider,
    protocol: CodingPlanProtocol,
    providers: CodingPlanProviderInfo[],
): string {
    const defaults = providerDefaults(provider, providers);
    return protocol === "anthropic"
        ? (defaults.anthropic || defaults.openai)
        : defaults.openai;
}

interface Props {
    membership: PayMembership | null;
    /** /quota/summary：Coding Plan 段用于展示「已用 token（今日/本月）」；缺省时整段隐藏 */
    quota?: QuotaSummary | null;
    onToast: (msg: string, type: "success" | "error") => void;
}

export function CodingPlanCard({ membership, quota, onToast }: Props) {
    const tier = (membership?.tier ?? "").toUpperCase();
    const isVip = Boolean(membership?.active) && (tier === "VIP" || tier === "SVIP" || tier === "PROMAX");

    const [plans, setPlans] = useState<CodingPlan[]>([]);
    // YAML provider catalog (labels + default Base URLs) served with the plans.
    const [providers, setProviders] = useState<CodingPlanProviderInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [editor, setEditor] = useState<
        { mode: "new" } | { mode: "edit"; plan: CodingPlan } | null
    >(null);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<CodingPlan | null>(null);
    const [testingId, setTestingId] = useState<number | null>(null);
    const [refreshingId, setRefreshingId] = useState<number | null>(null);
    const [testResults, setTestResults] = useState<
        Record<number, { ok: boolean; message: string; models?: string[] }>
    >({});

    const load = useCallback(async () => {
        if (!isVip) {
            setPlans([]);
            return;
        }
        setLoading(true);
        try {
            const data = await codingPlanApi.list();
            setPlans(data.plans);
            setProviders(data.providers);
            setLoadError(null);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, [isVip]);

    useEffect(() => {
        void load();
    }, [load]);

    function clearTestResult(id: number) {
        setTestResults((prev) => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
        });
    }

    /** 测试已保存的套餐：后端先探测 /models，失败后发一次最小聊天请求。 */
    async function testPlan(plan: CodingPlan) {
        setTestingId(plan.id);
        try {
            const result = await codingPlanApi.test(plan.id);
            setTestResults((prev) => ({ ...prev, [plan.id]: result }));
        } catch (e) {
            setTestResults((prev) => ({
                ...prev,
                [plan.id]: {
                    ok: false,
                    message: e instanceof Error ? e.message : "测试失败",
                },
            }));
        } finally {
            setTestingId(null);
        }
    }

    /** 强制刷新模型缓存（Redis），不落库；结果内联展示。 */
    async function refreshModels(plan: CodingPlan) {
        setRefreshingId(plan.id);
        try {
            const catalog = await codingPlanApi.models(plan.id, true);
            setTestResults((prev) => ({
                ...prev,
                [plan.id]: {
                    ok: true,
                    message: `已刷新模型列表（${catalog.models.length} 个）`,
                },
            }));
        } catch (e) {
            setTestResults((prev) => ({
                ...prev,
                [plan.id]: { ok: false, message: e instanceof Error ? e.message : "刷新模型失败" },
            }));
        } finally {
            setRefreshingId(null);
        }
    }

    async function save(input: CodingPlanInput) {
        if (!editor) return;
        setSaving(true);
        try {
            if (editor.mode === "edit") {
                const patch: CodingPlanPatch = { ...input };
                if (!patch.api_key) delete patch.api_key; // 空 = 不覆盖已存密钥
                const updated = await codingPlanApi.update(editor.plan.id, patch);
                setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
                clearTestResult(updated.id);
                onToast("Coding Plan 已更新", "success");
            } else {
                const created = await codingPlanApi.create(input);
                setPlans((prev) => [...prev, created]);
                onToast("Coding Plan 已添加", "success");
            }
            setEditor(null);
        } catch (e) {
            onToast(e instanceof Error ? e.message : "保存失败", "error");
        } finally {
            setSaving(false);
        }
    }

    async function toggle(plan: CodingPlan) {
        try {
            const updated = await codingPlanApi.update(plan.id, { enabled: !plan.enabled });
            setPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
            clearTestResult(updated.id);
        } catch (e) {
            onToast(e instanceof Error ? e.message : "操作失败", "error");
        }
    }

    async function toggleDefault(plan: CodingPlan) {
        try {
            if (plan.is_default) {
                await codingPlanApi.clearDefault();
                setPlans((prev) => prev.map((p) => ({ ...p, is_default: false })));
                onToast("已取消默认套餐", "success");
            } else {
                await codingPlanApi.setDefault(plan.id);
                setPlans((prev) => prev.map((p) => ({ ...p, is_default: p.id === plan.id })));
                onToast("已设为默认套餐", "success");
            }
        } catch (e) {
            onToast(e instanceof Error ? e.message : "操作失败", "error");
        }
    }

    function remove(plan: CodingPlan) {
        if (deletingId !== null) return;
        setDeleteTarget(plan);
    }

    async function performRemove() {
        const plan = deleteTarget;
        if (!plan) return;
        setDeletingId(plan.id);
        try {
            await codingPlanApi.remove(plan.id);
            setPlans((prev) => prev.filter((p) => p.id !== plan.id));
            clearTestResult(plan.id);
            if (editor?.mode === "edit" && editor.plan.id === plan.id) setEditor(null);
            setDeleteTarget(null);
            onToast("Coding Plan 已删除", "success");
        } catch (e) {
            onToast(e instanceof Error ? e.message : "删除失败", "error");
        } finally {
            setDeletingId(null);
        }
    }

    function startAdd() {
        if (plans.length >= MAX_PLANS) {
            onToast(`最多添加 ${MAX_PLANS} 个 Coding Plan`, "error");
            return;
        }
        setEditor({ mode: "new" });
    }

    // free：不请求任何 Coding Plan 数据，只展示升级信息卡。
    if (!isVip) {
        return (
            <GoogleCard>
                <CardHeader />
                <div className="px-5 pb-5">
                    <div className="rounded-xl p-4" style={{ background: C.pageBg }}>
                        <div className="flex items-start gap-3">
                            <span
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                                style={{ background: C.amberBg, color: C.amberText }}
                            >
                                <Lock className="h-5 w-5" />
                            </span>
                            <div className="min-w-0">
                                <h3 className="text-sm font-medium" style={{ color: C.text }}>
                                    Coding Plan 仅 VIP/SVIP/ProMax 可用
                                </h3>
                                <p
                                    className="mt-1 text-xs leading-relaxed"
                                    style={{ color: C.text2 }}
                                >
                                    VIP/SVIP/ProMax 可添加 OpenCode Zen/Go、Kimi Coding 或自定义
                                    OpenAI / Anthropic 兼容端点；在聊天模型选择器中切到 Coding Plan 即可使用套餐额度。
                                </p>
                                <Link
                                    href="/membership"
                                    className="mt-3 inline-flex h-8 items-center justify-center rounded-md px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                                    style={{ background: C.blue }}
                                >
                                    升级会员
                                </Link>
                            </div>
                        </div>
                    </div>
                </div>
            </GoogleCard>
        );
    }

    const enabledCount = plans.filter((p) => p.enabled).length;
    const atLimit = plans.length >= MAX_PLANS;
    // 用户自付套餐的 token 用量：只统计、不占平台 Credits；老后端没有该段。
    const codingPlan = quota?.codingPlan;
    const hasCodingPlanUsage = Boolean(
        codingPlan && (codingPlan.dayTokens > 0 || codingPlan.monthTokens > 0),
    );

    return (
        <GoogleCard>
            <CardHeader
                action={
                    editor === null ? (
                        <PillButton
                            onClick={startAdd}
                            disabled={atLimit}
                            title={atLimit ? `最多 ${MAX_PLANS} 个` : undefined}
                        >
                            <Plus className="h-4 w-4" />
                            添加
                        </PillButton>
                    ) : undefined
                }
            />

            {hasCodingPlanUsage && codingPlan && (
                <div
                    className="px-5 py-3"
                    style={{ borderTop: `1px solid ${C.line}`, background: C.pageBg }}
                >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-[12px]" style={{ color: C.text2 }}>
                            Coding Plan 已用 token（今日 / 本月）
                        </span>
                        <span
                            className="text-[13px] font-medium tabular-nums"
                            style={{ color: C.text }}
                        >
                            {formatTokens(codingPlan.dayTokens)} / {formatTokens(codingPlan.monthTokens)}
                            {typeof codingPlan.turns === "number" && codingPlan.turns > 0
                                ? ` · 今日 ${codingPlan.turns} 轮`
                                : ""}
                        </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed" style={{ color: C.text2 }}>
                        由你自己的套餐支付，不计入平台 Credits。
                        {codingPlan.byModel?.length
                            ? " 今日模型：" +
                              codingPlan.byModel
                                  .slice(0, 3)
                                  .map((m) => `${m.model} ${formatTokens(m.tokens)}`)
                                  .join(" · ")
                            : ""}
                    </p>
                </div>
            )}

            {loading ? (
                <div
                    className="flex items-center justify-center px-5 py-12"
                    style={{ borderTop: `1px solid ${C.line}` }}
                >
                    <Loader2 className="h-5 w-5 animate-spin" style={{ color: C.text2 }} />
                </div>
            ) : loadError ? (
                <div
                    className="flex items-start gap-2 px-5 py-4"
                    style={{ borderTop: `1px solid ${C.line}` }}
                >
                    <AlertCircle
                        className="mt-0.5 h-4 w-4 shrink-0"
                        style={{ color: C.red }}
                    />
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px]" style={{ color: C.text }}>
                            Coding Plan 加载失败
                        </p>
                        <p className="mt-0.5 break-words text-[12px]" style={{ color: C.text2 }}>
                            {loadError}
                        </p>
                    </div>
                    <TextAction onClick={() => void load()}>重试</TextAction>
                </div>
            ) : (
                <>
                    {plans.length > 0 && (
                        <div
                            className="px-5 pb-3 pt-3"
                            style={{ borderTop: `1px solid ${C.line}` }}
                        >
                            <div
                                className="flex items-center justify-between text-[11px]"
                                style={{ color: C.text2 }}
                            >
                                <span>
                                    已配置 {plans.length} / {MAX_PLANS}
                                </span>
                                <span>{enabledCount} 个启用</span>
                            </div>
                            <div
                                className="mt-2 h-1 w-full overflow-hidden rounded-full"
                                style={{ background: C.line }}
                            >
                                <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{
                                        width: `${(plans.length / MAX_PLANS) * 100}%`,
                                        background: C.blue,
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {plans.map((plan) => {
                        const visual = providerVisual(plan.provider);
                        const providerName = providerLabel(plan.provider, providers);
                        const busy = deletingId === plan.id;
                        const testing = testingId === plan.id;
                        const testResult = testResults[plan.id];
                        return (
                            <div
                                key={plan.id}
                                className="px-5 py-4"
                                style={{ borderTop: `1px solid ${C.line}` }}
                            >
                                <div className="flex flex-wrap items-start gap-3">
                                    <span
                                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                                        style={{ background: visual.bg, color: visual.fg }}
                                    >
                                        <visual.Icon className="h-4 w-4" />
                                    </span>

                                    <div className="min-w-0 flex-1 basis-[180px]">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span
                                                className="truncate text-sm font-medium"
                                                style={{ color: C.text }}
                                            >
                                                {plan.label || providerName}
                                            </span>
                                            <span
                                                className="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium"
                                                style={{ background: visual.bg, color: visual.fg }}
                                            >
                                                {providerName}
                                            </span>
                                            <span
                                                className="inline-flex items-center rounded px-2 py-0.5 text-[11px]"
                                                style={{
                                                    border: `1px solid ${C.border}`,
                                                    color: C.text2,
                                                }}
                                            >
                                                {plan.protocol === "anthropic"
                                                    ? "Anthropic"
                                                    : "OpenAI"}
                                            </span>
                                            {plan.is_default && (
                                                <span
                                                    className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium"
                                                    style={{ background: C.blueBg, color: C.blue }}
                                                >
                                                    <Star className="h-3 w-3" />
                                                    默认
                                                </span>
                                            )}
                                        </div>

                                        <div
                                            className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]"
                                            style={{ color: C.text2 }}
                                        >
                                            <span
                                                className="max-w-[220px] truncate"
                                                title={plan.base_url}
                                            >
                                                {plan.base_url}
                                            </span>
                                        </div>

                                        <div
                                            className="mt-1 flex items-center gap-1 text-[12px]"
                                            style={{ color: C.text2 }}
                                        >
                                            <KeyRound className="h-3 w-3 shrink-0" />
                                            <span className="truncate font-mono">
                                                {plan.api_key_masked || "****"}
                                            </span>
                                        </div>

                                    </div>

                                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                                        <div className="flex items-center gap-1.5">
                                            <span
                                                className="text-[11px]"
                                                style={{ color: plan.enabled ? C.blue : C.text2 }}
                                            >
                                                {plan.enabled ? "已启用" : "已停用"}
                                            </span>
                                            <Switch
                                                checked={plan.enabled}
                                                onChange={() => void toggle(plan)}
                                                label={`${plan.enabled ? "停用" : "启用"}${plan.label || providerName}`}
                                            />
                                        </div>
                                        <div className="flex items-center gap-0.5">
                                            <TextAction
                                                onClick={() => void testPlan(plan)}
                                                disabled={busy || testing}
                                            >
                                                {testing ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <PlugZap className="h-3 w-3" />
                                                )}
                                                {testing ? "测试中" : "测试"}
                                            </TextAction>
                                            <TextAction
                                                onClick={() => void toggleDefault(plan)}
                                                disabled={busy || !plan.enabled}
                                            >
                                                <Star className="h-3 w-3" />
                                                {plan.is_default ? "取消默认" : "设为默认"}
                                            </TextAction>
                                            <TextAction
                                                onClick={() => void refreshModels(plan)}
                                                disabled={busy || refreshingId === plan.id}
                                            >
                                                <RefreshCw
                                                    className={
                                                        refreshingId === plan.id
                                                            ? "h-3 w-3 animate-spin"
                                                            : "h-3 w-3"
                                                    }
                                                />
                                                {refreshingId === plan.id ? "刷新中" : "刷新模型"}
                                            </TextAction>
                                            <TextAction
                                                onClick={() =>
                                                    setEditor({ mode: "edit", plan })
                                                }
                                                disabled={busy}
                                            >
                                                <Pencil className="h-3 w-3" />
                                                编辑
                                            </TextAction>
                                            <TextAction
                                                tone="danger"
                                                onClick={() => remove(plan)}
                                                disabled={busy}
                                            >
                                                {deletingId === plan.id ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <Trash2 className="h-3 w-3" />
                                                )}
                                                删除
                                            </TextAction>
                                        </div>
                                    </div>
                                </div>

                                {testResult && (
                                    <div
                                        className="mt-2 rounded-md px-2.5 py-1.5 text-[11px] leading-relaxed"
                                        style={{
                                            background: testResult.ok ? C.greenBg : C.redBg,
                                            color: testResult.ok ? C.green : C.red,
                                        }}
                                        title={testResult.models?.slice(0, 30).join("\n")}
                                    >
                                        {testResult.ok ? "✓ " : "✕ "}
                                        {testResult.message || (testResult.ok ? "连接成功" : "连接失败")}
                                        {testResult.ok && testResult.models?.length
                                            ? ` · 获取到 ${testResult.models.length} 个模型`
                                            : ""}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {plans.length === 0 && editor === null && (
                        <div
                            className="px-5 py-10 text-center"
                            style={{ borderTop: `1px solid ${C.line}` }}
                        >
                            <span
                                className="mx-auto flex h-10 w-10 items-center justify-center rounded-full"
                                style={{ background: C.blueBg, color: C.blue }}
                            >
                                <KeyRound className="h-5 w-5" />
                            </span>
                            <h3 className="mt-3 text-sm font-medium" style={{ color: C.text }}>
                                还没有 Coding Plan
                            </h3>
                            <p
                                className="mx-auto mt-1 max-w-[320px] text-[12px] leading-relaxed"
                                style={{ color: C.text2 }}
                            >
                                添加 OpenCode Zen/Go、Kimi Coding 或自定义兼容端点后，站内 Code
                                Agent 会在需要时优先使用你的套餐额度。
                            </p>
                            <PillButton onClick={startAdd} className="mt-4">
                                <Plus className="h-4 w-4" />
                                添加第一个套餐
                            </PillButton>
                        </div>
                    )}

                    {editor && (
                        <PlanEditor
                            key={editor.mode === "edit" ? `edit-${editor.plan.id}` : "new"}
                            initial={editor.mode === "edit" ? editor.plan : null}
                            providers={providers}
                            saving={saving}
                            onCancel={() => setEditor(null)}
                            onSave={(input) => void save(input)}
                        />
                    )}

                    <ConfirmDialog
                        open={deleteTarget !== null}
                        title="删除这个 Coding Plan？"
                        message={
                            deleteTarget
                                ? `「${deleteTarget.label || providerLabel(deleteTarget.provider, providers)}」将从账户移除；之后对话会回落到平台默认模型。`
                                : ""
                        }
                        confirmLabel="删除"
                        danger
                        busy={deletingId !== null}
                        onConfirm={() => void performRemove()}
                        onCancel={() => {
                            if (deletingId !== null) return;
                            setDeleteTarget(null);
                        }}
                    />
                </>
            )}
        </GoogleCard>
    );
}

/* ── Google 风格原语 ─────────────────────────────────────────────── */

function GoogleCard({ children }: { children: ReactNode }) {
    return (
        <section
            className="overflow-visible rounded-lg bg-white"
            style={{ border: `1px solid ${C.border}` }}
        >
            {children}
        </section>
    );
}

/** 卡片头部：40px 圆形图标 + 标题 + 副标题 + 右上胶囊按钮。 */
function CardHeader({ action }: { action?: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3 px-5 py-5">
            <div className="flex min-w-0 items-start gap-3">
                <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: C.blueBg, color: C.blue }}
                >
                    <KeyRound className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-base font-medium leading-6" style={{ color: C.text }}>
                        Coding Plan
                    </h2>
                    <p className="mt-0.5 text-xs leading-relaxed" style={{ color: C.text2 }}>
                        为站内对话 / Code Agent 提供第三方编程套餐（VIP/SVIP/ProMax）
                    </p>
                </div>
            </div>
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}

function PillButton({
    children,
    onClick,
    disabled,
    loading,
    variant = "filled",
    className,
    title,
}: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: "filled" | "outlined";
    className?: string;
    title?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled || loading}
            title={title}
            className={cn(
                "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3.5 text-[13px] font-medium transition-colors disabled:opacity-40",
                variant === "filled"
                    ? "text-white hover:opacity-90"
                    : "bg-white hover:bg-[#f1f3f4]",
                className,
            )}
            style={
                variant === "filled"
                    ? { background: C.blue }
                    : { border: `1px solid ${C.border}`, color: C.blue }
            }
        >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {children}
        </button>
    );
}

function TextAction({
    children,
    onClick,
    disabled,
    tone = "blue",
}: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    tone?: "blue" | "danger";
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors hover:bg-[#f1f3f4] disabled:opacity-40"
            style={{ color: tone === "danger" ? C.red : C.blue }}
        >
            {children}
        </button>
    );
}

/** Google Material 式开关（36×20 轨道 + 14px 白色滑块）。 */
function Switch({
    checked,
    onChange,
    label,
    disabled,
}: {
    checked: boolean;
    onChange: () => void;
    label: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={onChange}
            className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
            style={{ background: checked ? C.blue : C.switchOff }}
        >
            <span
                className="absolute rounded-full bg-white transition-transform duration-150"
                style={{
                    left: 3,
                    height: 14,
                    width: 14,
                    transform: checked ? "translateX(16px)" : "translateX(0)",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
                }}
            />
        </button>
    );
}

function Field({
    label,
    hint,
    className,
    children,
}: {
    label: string;
    hint?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={className}>
            <label className="mb-1 block text-[11px] font-medium" style={{ color: C.text2 }}>
                {label}
            </label>
            {children}
            {hint && (
                <p className="mt-1 text-[11px] leading-snug" style={{ color: C.text2 }}>
                    {hint}
                </p>
            )}
        </div>
    );
}

/* ── 添加/编辑表单 ──────────────────────────────────────────────── */

/** 添加/编辑表单（key 只写；编辑时留空表示保持原密钥）。 */
function PlanEditor({
    initial,
    providers,
    saving,
    onCancel,
    onSave,
}: {
    initial: CodingPlan | null;
    providers: CodingPlanProviderInfo[];
    saving: boolean;
    onCancel: () => void;
    onSave: (input: CodingPlanInput) => void;
}) {
    const providerOptions =
        providers.length > 0
            ? providers.map((p) => ({ value: p.name, label: p.label }))
            : [{ value: "custom", label: "自定义端点" }];
    const initialProvider = initial?.provider ?? providerOptions[0]?.value ?? "custom";
    const initialProtocol: CodingPlanProtocol = initial?.protocol ?? "openai";
    const [provider, setProvider] = useState<CodingPlanProvider>(initialProvider);
    const [protocol, setProtocol] = useState<CodingPlanProtocol>(initialProtocol);
    const [label, setLabel] = useState(initial?.label ?? "");
    const [baseUrl, setBaseUrl] = useState(
        initial?.base_url ?? defaultBaseUrl(initialProvider, initialProtocol, providers),
    );
    const [model, setModel] = useState(initial?.model ?? "");
    const [modelOptions, setModelOptions] = useState<string[]>([]);
    const [apiKey, setApiKey] = useState("");
    const [enabled, setEnabled] = useState(initial?.enabled ?? true);
    const [error, setError] = useState<string | null>(null);
    // Existing plans: load the cached model catalog so the default model can
    // be picked from a list instead of typed from memory.
    useEffect(() => {
        if (!initial) return;
        let cancelled = false;
        void (async () => {
            try {
                const catalog = await codingPlanApi.models(initial.id);
                if (!cancelled) setModelOptions(catalog.models ?? []);
            } catch {
                /* catalog is optional (provider may expose no /models) */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [initial]);

    const defaults = providerDefaults(provider, providers);
    const basePlaceholder =
        defaultBaseUrl(provider, protocol, providers) || "https://api.example.com/v1";

    /** 切服务商：URL 为空或仍是上一家的默认值时，自动换成新端点。 */
    function changeProvider(next: CodingPlanProvider) {
        const prevDefault = defaultBaseUrl(provider, protocol, providers);
        const nextDefault = defaultBaseUrl(next, protocol, providers);
        setProvider(next);
        setBaseUrl((prev) => (!prev.trim() || prev === prevDefault ? nextDefault : prev));
    }

    /** 切协议：同上，自动切换到该协议对应的端点。 */
    function changeProtocol(next: CodingPlanProtocol) {
        const prevDefault = defaultBaseUrl(provider, protocol, providers);
        const nextDefault = defaultBaseUrl(provider, next, providers);
        setProtocol(next);
        setBaseUrl((prev) => (!prev.trim() || prev === prevDefault ? nextDefault : prev));
    }

    function submit() {
        const url = baseUrl.trim();
        if (!url) { setError("请填写 Base URL"); return; }
        if (!/^https?:\/\//i.test(url)) { setError("Base URL 必须以 http:// 或 https:// 开头"); return; }
        if (!initial && !apiKey.trim()) { setError("请填写 API Key"); return; }
        setError(null);
        onSave({
            provider,
            protocol,
            label: label.trim(),
            base_url: url,
            model: model.trim(),
            api_key: apiKey.trim(),
            enabled,
        });
    }

    return (
        <div style={{ borderTop: "1px solid " + C.line, background: C.pageBg }}>
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-2">
                <Field label="服务商">
                    <Select value={provider} onChange={changeProvider} options={providerOptions} ariaLabel="Coding Plan 服务商" />
                </Field>
                <Field label="协议">
                    <Select value={protocol} onChange={(v) => changeProtocol(v as CodingPlanProtocol)} options={PROTOCOL_OPTIONS} ariaLabel="Coding Plan 协议" />
                </Field>
                <Field label="名称（可选）">
                    <input className="field" aria-label="Coding Plan 名称" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 OpenCode Zen" />
                </Field>
                <Field
                    label="Base URL"
                    hint="选择服务商/协议后自动填入官方 Coding 端点；OpenAI 兼容通常以 /v1 结尾，Anthropic 兼容需填到 /v1（SDK 会追加 /messages）"
                    className="sm:col-span-2"
                >
                    <input className="field" aria-label="Coding Plan Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={basePlaceholder} autoComplete="off" />
                </Field>
                <Field
                    label="默认模型（可选）"
                    hint="设为默认套餐后，聊天会使用该模型；留空则取套餐模型列表的第一个（可从下拉建议中选择）"
                    className="sm:col-span-2"
                >
                    <input
                        className="field"
                        aria-label="Coding Plan 默认模型"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={defaults.model}
                        autoComplete="off"
                        list={initial ? `cp-model-options-${initial.id}` : undefined}
                    />
                    {initial && modelOptions.length > 0 && (
                        <datalist id={`cp-model-options-${initial.id}`}>
                            {modelOptions.map((m) => (
                                <option key={m} value={m} />
                            ))}
                        </datalist>
                    )}
                </Field>
                <Field label="API Key" hint={initial ? "留空保持现有密钥（加密存储，只显示掩码）" : "加密存储；只返回掩码"} className="sm:col-span-2">
                    <input className="field" aria-label="Coding Plan API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={initial ? "留空保持 " + (initial.api_key_masked || "****") : "sk-..."} autoComplete="new-password" />
                </Field>
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 sm:col-span-2" style={{ borderColor: C.border, background: C.surface }}>
                    <div>
                        <div className="text-[12px] font-medium" style={{ color: C.text }}>启用套餐</div>
                        <div className="mt-0.5 text-[11px]" style={{ color: C.text2 }}>对话 / Code Agent 只使用已启用的套餐；可随时停用。</div>
                    </div>
                    <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} label="启用 Coding Plan" />
                </div>
                {error && (
                    <p className="flex items-center gap-1 text-[12px] sm:col-span-2" style={{ color: C.red }}>
                        <AlertCircle className="h-3.5 w-3.5" />{error}
                    </p>
                )}
            </div>
            <div className="flex items-center gap-2 px-5 py-3" style={{ borderTop: "1px solid " + C.line }}>
                <span className="mr-auto hidden text-[11px] sm:inline" style={{ color: C.text2 }}>
                    保存后可在列表点「测试」验证连接
                </span>
                <PillButton variant="outlined" onClick={onCancel} disabled={saving}>取消</PillButton>
                <PillButton onClick={submit} loading={saving} disabled={saving}>{initial ? "保存修改" : "添加"}</PillButton>
            </div>
        </div>
    );
}
