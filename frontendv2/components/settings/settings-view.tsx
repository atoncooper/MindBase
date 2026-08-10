"use client";

/**
 * SettingsView - API 凭证设置 (OpenAI style).
 *
 * Left-aligned flex column managing three config sections: LLM credentials,
 * embedding configs, and ASR configs. Each supports create / edit / delete /
 * set-default / connection-test. Aligned with v1 dock-modules/settings.tsx.
 */
import { useCallback, useEffect, useState } from "react";
import {
    credentialsApi,
    embeddingConfigApi,
    asrConfigApi,
    type CredentialItem,
    type ConfigItem,
    type CredentialCreateParams,
    type CredentialUpdateParams,
    type ConfigCreateParams,
    type ConfigUpdateParams,
    type TestResultResponse,
} from "@/lib/api";
import { ConfigSection } from "./config-section";
import { CredentialForm, type ConfigFormType } from "./credential-form";
import type { DisplayItem } from "./credential-card";
import { ConfirmDialog } from "@/components/confirm-dialog";

type Toast = { message: string; type: "success" | "error" };
type FormMode = { type: ConfigFormType; item: DisplayItem | null } | null;
type DeleteTarget = { type: ConfigFormType; item: DisplayItem } | null;

export function SettingsView() {
    const [credentials, setCredentials] = useState<CredentialItem[]>([]);
    const [embConfigs, setEmbConfigs] = useState<ConfigItem[]>([]);
    const [asrConfigs, setAsrConfigs] = useState<ConfigItem[]>([]);

    const [loading, setLoading] = useState({ llm: false, emb: false, asr: false });
    const [formMode, setFormMode] = useState<FormMode>(null);
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
    const [deleting, setDeleting] = useState(false);
    const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
    const [toast, setToast] = useState<Toast | null>(null);

    const showToast = useCallback((message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), type === "error" ? 6000 : 3000);
    }, []);

    // ── Loaders ──
    const loadCredentials = useCallback(async () => {
        setLoading((p) => ({ ...p, llm: true }));
        try {
            setCredentials(await credentialsApi.list());
        } catch {
            /* best-effort */
        } finally {
            setLoading((p) => ({ ...p, llm: false }));
        }
    }, []);

    const loadEmbConfigs = useCallback(async () => {
        setLoading((p) => ({ ...p, emb: true }));
        try {
            setEmbConfigs(await embeddingConfigApi.list());
        } catch {
            /* best-effort */
        } finally {
            setLoading((p) => ({ ...p, emb: false }));
        }
    }, []);

    const loadAsrConfigs = useCallback(async () => {
        setLoading((p) => ({ ...p, asr: true }));
        try {
            setAsrConfigs(await asrConfigApi.list());
        } catch {
            /* best-effort */
        } finally {
            setLoading((p) => ({ ...p, asr: false }));
        }
    }, []);

    useEffect(() => {
        void (async () => {
            await loadCredentials();
            await loadEmbConfigs();
            await loadAsrConfigs();
        })();
    }, [loadCredentials, loadEmbConfigs, loadAsrConfigs]);

    // ── Reload helper per type ──
    function reload(type: ConfigFormType) {
        if (type === "llm") void loadCredentials();
        else if (type === "embedding") void loadEmbConfigs();
        else void loadAsrConfigs();
    }

    // ── Test ──
    async function handleTest(type: ConfigFormType, id: number) {
        setTestingIds((prev) => new Set(prev).add(id));
        try {
            let result: TestResultResponse;
            if (type === "llm") result = await credentialsApi.test(id);
            else if (type === "embedding") result = await embeddingConfigApi.test(id);
            else result = await asrConfigApi.test(id);

            if (result.status === "ok") showToast("连接测试成功", "success");
            else showToast(result.error || "连接测试失败", "error");
            reload(type);
        } catch (e) {
            showToast(e instanceof Error ? e.message : "测试失败", "error");
        } finally {
            setTestingIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    }

    // ── Set default ──
    async function handleSetDefault(type: ConfigFormType, id: number, name: string) {
        try {
            if (type === "llm") await credentialsApi.setDefault(id);
            else if (type === "embedding") await embeddingConfigApi.setDefault(id);
            else await asrConfigApi.setDefault(id);
            showToast(`已将"${name}"设为默认`, "success");
            reload(type);
        } catch (e) {
            showToast(e instanceof Error ? e.message : "操作失败", "error");
        }
    }

    // ── Delete ──
    async function handleDelete() {
        if (!deleteTarget) return;
        const { type, item } = deleteTarget;
        setDeleting(true);
        try {
            if (type === "llm") await credentialsApi.delete(item.id);
            else if (type === "embedding") await embeddingConfigApi.delete(item.id);
            else await asrConfigApi.delete(item.id);
            setDeleteTarget(null);
            showToast("已删除", "success");
            reload(type);
        } catch (e) {
            showToast(e instanceof Error ? e.message : "删除失败", "error");
        } finally {
            setDeleting(false);
        }
    }

    // ── Form save (errors propagate to the form for inline display) ──
    async function handleFormSave(data: Record<string, string | boolean>) {
        if (!formMode) return;
        const { type, item } = formMode;
        const isEdit = !!item;
        if (type === "llm") {
            if (isEdit)
                await credentialsApi.update(item.id, data as CredentialUpdateParams);
            else
                await credentialsApi.create(
                    data as unknown as CredentialCreateParams,
                );
        } else if (type === "embedding") {
            if (isEdit)
                await embeddingConfigApi.update(item.id, data as ConfigUpdateParams);
            else
                await embeddingConfigApi.create(
                    data as unknown as ConfigCreateParams,
                );
        } else {
            if (isEdit) await asrConfigApi.update(item.id, data as ConfigUpdateParams);
            else
                await asrConfigApi.create(data as unknown as ConfigCreateParams);
        }
        setFormMode(null);
        showToast(isEdit ? "已更新" : "已创建", "success");
        reload(type);
    }

    // Map LLM credentials to the common display shape (default_model -> model).
    const llmItems: DisplayItem[] = credentials.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        masked_key: c.masked_key,
        base_url: c.base_url,
        model: c.default_model,
        is_default: c.is_default,
        last_test_status: c.last_test_status,
        last_test_error: c.last_test_error,
    }));

    return (
        <div className="flex flex-col gap-5 px-6 py-8 sm:px-10">
            {toast && (
                <div
                    className={`fixed right-6 top-20 z-50 rounded-md border px-4 py-2.5 text-[13px] font-medium shadow-sm ${
                        toast.type === "success"
                            ? "border-success/20 bg-surface text-success"
                            : "border-danger/20 bg-surface text-danger"
                    }`}
                >
                    {toast.message}
                </div>
            )}

            {/* Header */}
            <div>
                <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
                    API 凭证设置
                </h1>
                <p className="mt-1 text-[13px] text-secondary">
                    统一管理对话、向量化与语音识别所使用的 API Key 和模型配置。
                </p>
            </div>

            <ConfigSection
                title="LLM 凭证"
                description="管理大语言模型的 API Key，支持多服务商配置。"
                items={llmItems}
                loading={loading.llm}
                testingIds={testingIds}
                onAdd={() => setFormMode({ type: "llm", item: null })}
                onEdit={(item) => setFormMode({ type: "llm", item })}
                onDelete={(item) => setDeleteTarget({ type: "llm", item })}
                onSetDefault={(item) => handleSetDefault("llm", item.id, item.name)}
                onTest={(item) => handleTest("llm", item.id)}
            />

            <ConfigSection
                title="Embedding"
                description="管理向量化 / Embedding 模型的 API Key，用于知识库构建与检索。"
                items={embConfigs}
                loading={loading.emb}
                testingIds={testingIds}
                onAdd={() => setFormMode({ type: "embedding", item: null })}
                onEdit={(item) => setFormMode({ type: "embedding", item })}
                onDelete={(item) => setDeleteTarget({ type: "embedding", item })}
                onSetDefault={(item) => handleSetDefault("embedding", item.id, item.name)}
                onTest={(item) => handleTest("embedding", item.id)}
            />

            <ConfigSection
                title="ASR 语音识别"
                description="管理语音转文字服务的 API Key，用于视频音频内容提取。"
                items={asrConfigs}
                loading={loading.asr}
                testingIds={testingIds}
                onAdd={() => setFormMode({ type: "asr", item: null })}
                onEdit={(item) => setFormMode({ type: "asr", item })}
                onDelete={(item) => setDeleteTarget({ type: "asr", item })}
                onSetDefault={(item) => handleSetDefault("asr", item.id, item.name)}
                onTest={(item) => handleTest("asr", item.id)}
            />

            {/* Notes */}
            <div className="rounded-lg border border-border-subtle bg-border-subtle/40 px-5 py-4 text-[12px] leading-relaxed text-secondary">
                <p>
                    如果不配置你自己的密钥，系统会回退到共享默认配置，<strong className="text-foreground">可能产生费用</strong>。
                </p>
                <p className="mt-1">
                    修改 Embedding 模型后，通常需要重新构建知识库才能保持检索一致性。
                </p>
            </div>

            {/* Form modal */}
            {formMode && (
                <CredentialForm
                    type={formMode.type}
                    item={formMode.item}
                    onSave={handleFormSave}
                    onCancel={() => setFormMode(null)}
                />
            )}

            {/* Delete confirm */}
            <ConfirmDialog
                open={!!deleteTarget}
                title="删除配置"
                message={`确定删除"${deleteTarget?.item.name ?? ""}"吗？此操作无法撤销。`}
                confirmLabel="删除"
                danger
                busy={deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleteTarget(null)}
            />
        </div>
    );
}
