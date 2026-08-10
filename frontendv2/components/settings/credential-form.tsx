"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Eye, EyeOff, Loader2, X } from "lucide-react";
import type { DisplayItem } from "./credential-card";

export type ConfigFormType = "llm" | "embedding" | "asr";

interface ProviderOption {
    value: string;
    label: string;
    placeholder_url: string;
}

const LLM_PROVIDERS: ProviderOption[] = [
    { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
    { value: "anthropic", label: "Anthropic", placeholder_url: "https://api.anthropic.com" },
    { value: "deepseek", label: "DeepSeek", placeholder_url: "https://api.deepseek.com" },
    { value: "custom", label: "Custom", placeholder_url: "" },
];

const EMBEDDING_PROVIDERS: ProviderOption[] = [
    { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
    { value: "dashscope", label: "DashScope", placeholder_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { value: "custom", label: "Custom", placeholder_url: "" },
];

const ASR_PROVIDERS: ProviderOption[] = [
    { value: "dashscope", label: "DashScope", placeholder_url: "https://dashscope.aliyuncs.com/api/v1" },
    { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
    { value: "custom", label: "Custom", placeholder_url: "" },
];

function getProviders(type: ConfigFormType): ProviderOption[] {
    if (type === "llm") return LLM_PROVIDERS;
    if (type === "embedding") return EMBEDDING_PROVIDERS;
    return ASR_PROVIDERS;
}

function modelPlaceholder(type: ConfigFormType, provider: string): string {
    if (type === "llm") {
        if (provider === "openai") return "gpt-4o";
        if (provider === "anthropic") return "claude-sonnet-4-6";
        if (provider === "deepseek") return "deepseek-chat";
        return "";
    }
    if (type === "embedding") return "text-embedding-3-small";
    return "paraformer-v2";
}

interface Props {
    type: ConfigFormType;
    item: DisplayItem | null;
    onSave: (data: Record<string, string | boolean>) => Promise<void>;
    onCancel: () => void;
}

export function CredentialForm({ type, item, onSave, onCancel }: Props) {
    const isEdit = !!item;
    const isLLM = type === "llm";
    const providers = getProviders(type);

    const [name, setName] = useState(item?.name ?? "");
    const [provider, setProvider] = useState(
        item?.provider ?? (type === "asr" ? "dashscope" : "openai"),
    );
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState(item?.base_url ?? "");
    const [model, setModel] = useState(item?.model ?? "");
    const [isDefault, setIsDefault] = useState(item?.is_default ?? false);
    const [showKey, setShowKey] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selected = providers.find((p) => p.value === provider);

    // Escape to cancel.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !saving) onCancel();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [saving, onCancel]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) {
            setError("请输入名称");
            return;
        }
        if (!isEdit && !apiKey.trim()) {
            setError("请输入 API Key");
            return;
        }
        setSaving(true);
        try {
            const data: Record<string, string | boolean> = {
                name: name.trim(),
                ...(isEdit ? {} : { provider }),
                ...(apiKey ? { api_key: apiKey.trim() } : {}),
                base_url: baseUrl.trim() || selected?.placeholder_url || "",
                ...(isEdit ? {} : { is_default: isDefault }),
            };
            if (model.trim()) {
                data[isLLM ? "default_model" : "model"] = model.trim();
            }
            await onSave(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存失败");
        } finally {
            setSaving(false);
        }
    }

    if (typeof document === "undefined") return null;

    return createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-black/30"
                onClick={saving ? undefined : onCancel}
            />
            <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                className="relative flex max-h-[90vh] w-full max-w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]"
                role="dialog"
                aria-modal="true"
            >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                        {isEdit ? "编辑配置" : "新增配置"}
                    </h2>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={saving}
                        className="grid h-7 w-7 place-items-center rounded-md text-secondary hover:bg-border-subtle hover:text-foreground disabled:opacity-40"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <form
                    onSubmit={handleSubmit}
                    className="flex flex-col gap-4 overflow-y-auto px-5 py-4"
                >
                    <Field label="名称">
                        <input
                            className="field"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="例如：我的 OpenAI Key"
                            autoFocus
                        />
                    </Field>

                    <Field label="服务商">
                        <select
                            className="field"
                            value={provider}
                            onChange={(e) => {
                                setProvider(e.target.value);
                                setBaseUrl("");
                            }}
                        >
                            {providers.map((p) => (
                                <option key={p.value} value={p.value}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
                    </Field>

                    <Field
                        label={
                            <>
                                API Key
                                {isEdit && !apiKey && (
                                    <span className="ml-1 text-[10px] font-medium text-success">
                                        保持不变
                                    </span>
                                )}
                            </>
                        }
                    >
                        <div className="relative">
                            <input
                                type={showKey ? "text" : "password"}
                                className="field pr-9"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={isEdit && !apiKey ? "••••••••" : "sk-…"}
                            />
                            <button
                                type="button"
                                onClick={() => setShowKey((s) => !s)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded text-secondary hover:text-foreground"
                            >
                                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </Field>

                    <Field label="接口地址">
                        <input
                            className="field"
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            placeholder={selected?.placeholder_url || ""}
                        />
                    </Field>

                    <Field label={isLLM ? "默认模型" : "模型"}>
                        <input
                            className="field"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder={modelPlaceholder(type, provider)}
                        />
                    </Field>

                    {!isEdit && (
                        <label className="flex items-center gap-2 text-[13px] text-secondary">
                            <input
                                type="checkbox"
                                checked={isDefault}
                                onChange={(e) => setIsDefault(e.target.checked)}
                                className="h-4 w-4 accent-foreground"
                            />
                            设为默认凭证
                        </label>
                    )}

                    {error && (
                        <div className="rounded-md border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={saving}
                            className="inline-flex h-8 items-center rounded-md border border-border px-3.5 text-[12px] text-secondary hover:bg-border-subtle disabled:opacity-40"
                        >
                            取消
                        </button>
                        <button
                            type="submit"
                            disabled={saving}
                            className="inline-flex h-8 items-center rounded-md bg-foreground px-3.5 text-[12px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
                        >
                            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            保存
                        </button>
                    </div>
                </form>
            </motion.div>
        </div>,
        document.body,
    );
}

function Field({
    label,
    children,
}: {
    label: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <label className="block">
            <span className="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-secondary">
                {label}
            </span>
            {children}
        </label>
    );
}
