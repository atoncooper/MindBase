"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Star, ShieldCheck, Zap } from "lucide-react";
import {
  credentialsApi, embeddingConfigApi, asrConfigApi,
  type CredentialItem, type CredentialCreateParams, type CredentialUpdateParams,
  type ConfigItem, type ConfigCreateParams, type ConfigUpdateParams,
  type TestResultResponse,
} from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";
import CredentialForm from "./credential-form";
import ConfirmDialog from "./confirm-dialog";

/* ──── Icons ──── */

function ProviderIcon({ provider }: { provider: string }) {
  const color = provider === "openai" ? "#06b6d4" : provider === "anthropic" ? "#a78bfa" : provider === "deepseek" ? "#f87171" : provider === "dashscope" ? "#fbbf24" : "#6b7280";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7" stroke={color} strokeWidth="1.5" fill={color} fillOpacity=".08"/>
      <path d="M8 14l3-4 2 4 3-6" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

/* ──── Shared card-list section ──── */

interface ConfigSectionProps<T extends { id: number; name: string; provider: string; masked_key: string; model: string | null; is_default: boolean; last_test_status?: string | null; last_test_error?: string | null }> {
  title: string;
  description: string;
  items: T[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
  onSetDefault: (item: T) => void;
  onTest: (item: T) => void;
  testingIds: Set<number>;
}

function ConfigSection<T extends { id: number; name: string; provider: string; masked_key: string; model: string | null; is_default: boolean; last_test_status?: string | null; last_test_error?: string | null }>({
  title, description, items, loading, onAdd, onEdit, onDelete, onSetDefault, onTest, testingIds,
}: ConfigSectionProps<T>) {
  return (
    <div className="sk-section">
      <div className="sk-section-head">
        <div className="sk-section-titlebox">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <button className="sk-add-btn" onClick={onAdd}>
          <Plus size={15} />
          <span>新增</span>
        </button>
      </div>
      {loading ? (
        <div className="sk-loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="sk-empty">
          <p>暂未配置</p>
          <p className="sk-empty-sub">点击"新增"添加配置</p>
        </div>
      ) : (
        <div className="sk-list">
          {items.map(item => (
            <div key={item.id} className={`sk-cred-card ${item.is_default ? "is-default" : ""}`}>
              <div className="sk-cred-top">
                <span className="sk-cred-icon"><ProviderIcon provider={item.provider} /></span>
                <div className="sk-cred-info">
                  <div className="sk-cred-name">
                    <span className="sk-cred-name-text">{item.name}</span>
                    {item.is_default && <span className="sk-default-badge"><ShieldCheck size={11} /> 默认</span>}
                  </div>
                  <div className="sk-cred-meta">
                    <span className="sk-provider-tag">{item.provider}</span>
                    <span className="sk-masked">密钥：{item.masked_key}</span>
                    {item.model && <span className="sk-model">模型：{item.model}</span>}
                  </div>
                </div>
              </div>
              <div className="sk-cred-actions">
                {item.last_test_status === "ok" && (
                  <span className="sk-test-status sk-test-ok" title="连接正常">&#9679;</span>
                )}
                {item.last_test_status === "error" && (
                  <span className="sk-test-status sk-test-err" title={item.last_test_error || "连接失败"}>
                    &#9679; {item.last_test_error}
                  </span>
                )}
                <button
                  className={`sk-act-btn sk-act-test ${testingIds.has(item.id) ? "is-testing" : ""}`}
                  title="测试连接"
                  onClick={() => onTest(item)}
                  disabled={testingIds.has(item.id)}
                >
                  {testingIds.has(item.id) ? (
                    <span className="sk-spinner" />
                  ) : (
                    <Zap size={14} />
                  )}
                </button>
                <button className="sk-act-btn" title="编辑" onClick={() => onEdit(item)}>
                  <Pencil size={14} />
                </button>
                {!item.is_default && (
                  <button className="sk-act-btn sk-act-star" title="设为默认" onClick={() => onSetDefault(item)}>
                    <Star size={14} />
                  </button>
                )}
                <button className="sk-act-btn sk-act-del" title="删除" onClick={() => onDelete(item)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──── Main ──── */

type FormMode = { type: "llm" | "embedding" | "asr"; item?: CredentialItem | ConfigItem | null } | null;

export default function SettingsPanel({ isOpen }: DockPanelProps) {
  // LLM
  const [credentials, setCredentials] = useState<CredentialItem[]>([]);
  // Embedding
  const [embConfigs, setEmbConfigs] = useState<ConfigItem[]>([]);
  // ASR
  const [asrConfigs, setAsrConfigs] = useState<ConfigItem[]>([]);

  const [loading, setLoading] = useState({ llm: false, emb: false, asr: false });
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "llm" | "embedding" | "asr"; item: CredentialItem | ConfigItem } | null>(null);
  const [testingIds, setTestingIds] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = (message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleTest = async (type: "llm" | "embedding" | "asr", id: number) => {
    setTestingIds(prev => new Set(prev).add(id));
    try {
      let result: TestResultResponse;
      if (type === "llm") result = await credentialsApi.test(id);
      else if (type === "embedding") result = await embeddingConfigApi.test(id);
      else result = await asrConfigApi.test(id);

      if (result.status === "ok") {
        showToast("连接测试成功", "success");
      } else {
        showToast(result.error || "连接测试失败", "error");
      }
      // Reload to get updated last_test_status from server
      if (type === "llm") await loadCredentials();
      else if (type === "embedding") await loadEmbConfigs();
      else await loadAsrConfigs();
    } catch (e: any) {
      showToast(e.message || "测试失败", "error");
    } finally {
      setTestingIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  // ── Loaders ──

  const loadCredentials = useCallback(async () => {
    setLoading(p => ({ ...p, llm: true }));
    try { setCredentials(await credentialsApi.list()); } catch {}
    finally { setLoading(p => ({ ...p, llm: false })); }
  }, []);

  const loadEmbConfigs = useCallback(async () => {
    setLoading(p => ({ ...p, emb: true }));
    try { setEmbConfigs(await embeddingConfigApi.list()); } catch {}
    finally { setLoading(p => ({ ...p, emb: false })); }
  }, []);

  const loadAsrConfigs = useCallback(async () => {
    setLoading(p => ({ ...p, asr: true }));
    try { setAsrConfigs(await asrConfigApi.list()); } catch {}
    finally { setLoading(p => ({ ...p, asr: false })); }
  }, []);

  useEffect(() => { if (isOpen) { loadCredentials(); loadEmbConfigs(); loadAsrConfigs(); } }, [isOpen, loadCredentials, loadEmbConfigs, loadAsrConfigs]);

  // ── Handlers ──

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { type, item } = deleteTarget;
    if (type === "llm") await credentialsApi.delete(item.id);
    else if (type === "embedding") await embeddingConfigApi.delete(item.id);
    else await asrConfigApi.delete(item.id);
    setDeleteTarget(null);
    showToast("已删除", "success");
    if (type === "llm") loadCredentials(); else if (type === "embedding") loadEmbConfigs(); else loadAsrConfigs();
  };

  const handleSetDefault = async (type: "llm" | "embedding" | "asr", id: number, name: string) => {
    if (type === "llm") await credentialsApi.setDefault(id);
    else if (type === "embedding") await embeddingConfigApi.setDefault(id);
    else await asrConfigApi.setDefault(id);
    showToast(`已将"${name}"设为默认`, "success");
    if (type === "llm") loadCredentials(); else if (type === "embedding") loadEmbConfigs(); else loadAsrConfigs();
  };

  // ── Form save ──

  const handleFormSave = async (data: CredentialCreateParams | CredentialUpdateParams | ConfigCreateParams | ConfigUpdateParams) => {
    if (!formMode) return;
    const { type, item } = formMode;
    const isEdit = !!item;

    if (type === "llm") {
      if (isEdit) await credentialsApi.update(item.id, data as CredentialUpdateParams);
      else await credentialsApi.create(data as CredentialCreateParams);
      loadCredentials();
    } else if (type === "embedding") {
      if (isEdit) await embeddingConfigApi.update(item.id, data as ConfigUpdateParams);
      else await embeddingConfigApi.create(data as ConfigCreateParams);
      loadEmbConfigs();
    } else {
      if (isEdit) await asrConfigApi.update(item.id, data as ConfigUpdateParams);
      else await asrConfigApi.create(data as ConfigCreateParams);
      loadAsrConfigs();
    }
    setFormMode(null);
    showToast(isEdit ? "已更新" : "已创建", "success");
  };

  if (!isOpen) return null;

  return (
    <div className="sk-panel">
      {toast && (
        <div className={`sk-toast ${toast.type}`}>
          {toast.message}
        </div>
      )}

      {formMode && (
        <CredentialForm
          type={formMode.type}
          credential={formMode.item ? { ...formMode.item, default_model: (formMode.item as any).default_model ?? (formMode.item as any).model, model: (formMode.item as any).model ?? (formMode.item as any).default_model } as any : null}
          onSave={handleFormSave}
          onCancel={() => setFormMode(null)}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除配置"
        message={`确定删除"${deleteTarget?.item.name ?? ""}"吗？此操作无法撤销。`}
        confirmLabel="删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <div className="sk-head">
          <div>
            <span className="sk-kicker">凭证中心</span>
            <h2>API 凭证设置</h2>
            <p>统一管理对话、向量化与语音识别所使用的 API Key 和模型配置。</p>
          </div>
          <div className="sk-head-stat">
            <strong>{credentials.length + embConfigs.length + asrConfigs.length}</strong>
            <span>配置项</span>
          </div>
        </div>

        <div className="sk-overview">
          <div className="sk-overview-card">
            <div><strong>{credentials.length}</strong><p>LLM 凭证</p></div>
          </div>
          <div className="sk-overview-card">
            <div><strong>{embConfigs.length}</strong><p>Embedding 配置</p></div>
          </div>
          <div className="sk-overview-card">
            <div><strong>{asrConfigs.length}</strong><p>ASR 配置</p></div>
          </div>
        </div>

        <ConfigSection
          title="LLM 凭证"
          description="管理大语言模型的 API Key，支持多服务商配置。"
          items={credentials.map(c => ({ ...c, model: c.default_model }))}
          loading={loading.llm}
          onAdd={() => setFormMode({ type: "llm" })}
          onEdit={(item) => setFormMode({ type: "llm", item })}
          onDelete={(item) => setDeleteTarget({ type: "llm", item })}
          onSetDefault={(item) => handleSetDefault("llm", item.id, item.name)}
          onTest={(item) => handleTest("llm", item.id)}
          testingIds={testingIds}
        />

        <ConfigSection
          title="Embedding"
          description="管理向量化/Embedding 模型的 API Key，用于知识库构建与检索。"
          items={embConfigs}
          loading={loading.emb}
          onAdd={() => setFormMode({ type: "embedding" })}
          onEdit={(item) => setFormMode({ type: "embedding", item })}
          onDelete={(item) => setDeleteTarget({ type: "embedding", item })}
          onSetDefault={(item) => handleSetDefault("embedding", item.id, item.name)}
          onTest={(item) => handleTest("embedding", item.id)}
          testingIds={testingIds}
        />

        <ConfigSection
          title="ASR 语音识别"
          description="管理语音转文字服务的 API Key，用于视频音频内容提取。"
          items={asrConfigs}
          loading={loading.asr}
          onAdd={() => setFormMode({ type: "asr" })}
          onEdit={(item) => setFormMode({ type: "asr", item })}
          onDelete={(item) => setDeleteTarget({ type: "asr", item })}
          onSetDefault={(item) => handleSetDefault("asr", item.id, item.name)}
          onTest={(item) => handleTest("asr", item.id)}
          testingIds={testingIds}
        />

        <div className="sk-note">
          <p>如果不配置你自己的密钥，系统会回退到共享默认配置，<strong>可能产生费用</strong>。</p>
          <p>修改 Embedding 模型后，通常需要重新构建知识库才能保持检索一致性。</p>
        </div>

      <style jsx global>{`
        .sk-panel {
          height: 100%; flex: 1; display: flex; flex-direction: column; gap: 14px;
          padding: 22px; overflow-y: auto;
          background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.1), transparent 28%), linear-gradient(180deg, #161b22 0%, #21262d 100%);
          color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif;
        }
        .sk-toast {
          position: fixed; top: 12px; right: 14px; padding: 7px 14px; border-radius: 7px;
          font-size: 12.5px; font-weight: 500; z-index: 10000;
          backdrop-filter: blur(8px); animation: skSlideIn .25s ease;
        }
        .sk-toast.success { background: rgba(34, 197, 94, 0.1); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.2); }
        .sk-toast.error   { background: rgba(248, 113, 113, 0.1); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.2); }
        @keyframes skSlideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }

        .sk-head {
          display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;
          padding: 18px; border-radius: 18px; border: 1px solid rgba(48, 54, 61, 0.9);
          background: linear-gradient(135deg, rgba(22, 27, 34, 0.98) 0%, rgba(33, 38, 45, 0.94) 100%);
        }
        .sk-kicker { display: inline-flex; align-items: center; margin-bottom: 8px; padding: 4px 10px; border-radius: 999px; background: rgba(6, 182, 212, 0.08); color: #06b6d4; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        .sk-head h2 { font-size: 17px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.02em; }
        .sk-head p { max-width: 540px; font-size: 12.5px; color: #8b949e; margin: 0; }
        .sk-head-stat { display: grid; gap: 2px; min-width: 108px; padding: 12px 14px; border-radius: 14px; background: linear-gradient(160deg, rgba(6, 182, 212, 0.08) 0%, rgba(6, 182, 212, 0.15) 100%); border: 1px solid rgba(6, 182, 212, 0.9); color: #22d3ee; text-align: right; }
        .sk-head-stat strong { font-size: 22px; line-height: 1; font-weight: 700; }
        .sk-head-stat span { font-size: 11px; font-weight: 600; opacity: 0.88; text-transform: uppercase; letter-spacing: 0.05em; }

        .sk-overview { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
        .sk-overview-card { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 18px; border: 1px solid rgba(48, 54, 61, 0.92); background: linear-gradient(180deg, #161b22 0%, #21262d 100%); }
        .sk-overview-card strong { display: block; font-size: 15px; font-weight: 700; color: #e2e8f0; }
        .sk-overview-card p { margin: 2px 0 0; font-size: 12px; color: #8b949e; font-weight: 500; }

        .sk-section { border: 1px solid rgba(48, 54, 61, 0.92); border-radius: 18px; background: rgba(22, 27, 34, 0.94); display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
        .sk-section-head { display: flex; align-items: center; gap: 10px; padding: 15px 18px; border-bottom: 1px solid rgba(48, 54, 61, 0.88); background: linear-gradient(180deg, rgba(33, 38, 45, 0.95) 0%, rgba(22, 27, 34, 0.92) 100%); }
        .sk-section-head h3 { font-size: 14px; font-weight: 700; margin: 0; }
        .sk-section-titlebox { flex: 1; min-width: 0; }
        .sk-section-titlebox p { margin: 3px 0 0; font-size: 12px; color: #8b949e; line-height: 1.5; }

        .sk-add-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 13px; border: 1px solid rgba(6, 182, 212, 0.95); border-radius: 10px; background: linear-gradient(180deg, #161b22 0%, #21262d 100%); color: #e2e8f0; font-size: 12.5px; font-weight: 650; cursor: pointer; flex-shrink: 0; transition: background .12s, border-color .12s, transform .12s; }
        .sk-add-btn:hover { background: rgba(6, 182, 212, 0.08); border-color: #22d3ee; transform: translateY(-1px); }

        .sk-loading { padding: 28px; text-align: center; font-size: 13px; color: #8b949e; }
        .sk-empty { padding: 30px 24px; text-align: center; }
        .sk-empty p { margin: 0; font-size: 13px; color: #8b949e; font-weight: 600; }
        .sk-empty-sub { font-size: 12px !important; color: #8b949e !important; margin-top: 6px !important; font-weight: 500 !important; }

        .sk-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow-y: auto; gap: 14px; max-height: 320px; padding: 18px; }
        .sk-cred-card { display: flex; flex-direction: column; justify-content: space-between; padding: 16px; border: 1px solid rgba(48, 54, 61, 0.92); border-radius: 16px; gap: 12px; background: linear-gradient(180deg, #161b22 0%, #21262d 100%); min-width: 0; transition: background .12s, transform .12s, box-shadow .12s, border-color .12s; }
        .sk-cred-card.is-default { background: radial-gradient(circle at top right, rgba(34, 197, 94, 0.11), transparent 34%), linear-gradient(180deg, #161b22 0%, #21262d 100%); border-color: rgba(34, 197, 94, 0.25); }
        .sk-cred-card:hover { transform: translateY(-2px); border-color: rgba(6, 182, 212, 0.15); box-shadow: 0 14px 32px rgba(6, 182, 212, 0.1); }
        .sk-cred-card.is-default:hover { box-shadow: 0 16px 34px rgba(34, 197, 94, 0.12); }
        .sk-cred-top { display: flex; align-items: flex-start; gap: 10px; min-width: 0; flex: 1; }
        .sk-cred-icon { display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 12px; color: #06b6d4; background: rgba(6, 182, 212, 0.08); border: 1px solid rgba(6, 182, 212, 0.8); flex-shrink: 0; }
        .sk-cred-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
        .sk-cred-name { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px; min-width: 0; }
        .sk-cred-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sk-default-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 700; color: #4ade80; background: rgba(34, 197, 94, 0.15); padding: 3px 7px; border-radius: 999px; border: 1px solid rgba(34, 197, 94, 0.2); flex-shrink: 0; }
        .sk-cred-meta { display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; color: #8b949e; flex-wrap: wrap; }
        .sk-provider-tag { font-weight: 700; color: #06b6d4; text-transform: capitalize; flex-shrink: 0; padding: 4px 8px; border-radius: 999px; background: rgba(6, 182, 212, 0.08); }
        .sk-masked { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 11px; padding: 4px 8px; border-radius: 999px; background: #21262d; border: 1px solid rgba(48, 54, 61, 0.95); }
        .sk-model { font-size: 11px; color: #8b949e; padding: 4px 8px; border-radius: 999px; background: #21262d; border: 1px solid rgba(48, 54, 61, 0.95); }

        .sk-cred-actions { display: flex; justify-content: flex-end; gap: 6px; flex-shrink: 0; }
        .sk-act-btn { background: #161b22; border: 1px solid rgba(48, 54, 61, 0.95); padding: 8px; border-radius: 10px; cursor: pointer; color: #8b949e; display: flex; transition: color .12s, background .12s, border-color .12s, transform .12s; }
        .sk-act-btn:hover { color: #e2e8f0; background: rgba(6, 182, 212, 0.08); border-color: rgba(6, 182, 212, 0.15); transform: translateY(-1px); }
        .sk-act-star:hover { color: #fbbf24; border-color: rgba(251, 191, 36, 0.2); background: rgba(251, 191, 36, 0.1); }
        .sk-act-del:hover { color: #f87171; border-color: rgba(248, 113, 113, 0.2); background: rgba(248, 113, 113, 0.1); }

        .sk-note { font-size: 12px; color: #8b949e; padding: 14px 15px; background: linear-gradient(180deg, #21262d 0%, rgba(6, 182, 212, 0.08) 100%); border: 1px solid rgba(6, 182, 212, 0.9); border-radius: 16px; line-height: 1.7; flex-shrink: 0; }

        /* light mode */
        html:not(.dark) .sk-panel { background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.08), transparent 28%), linear-gradient(180deg, var(--card) 0%, var(--paper) 100%); color: var(--foreground); }
        html:not(.dark) .sk-head { border-color: var(--border); background: linear-gradient(135deg, var(--card) 0%, var(--paper) 100%); }
        html:not(.dark) .sk-head h2 { color: var(--foreground); }
        html:not(.dark) .sk-head p { color: var(--muted-foreground); }
        html:not(.dark) .sk-overview-card { border-color: var(--border); background: linear-gradient(180deg, var(--card) 0%, var(--paper) 100%); }
        html:not(.dark) .sk-overview-card strong { color: var(--foreground); }
        html:not(.dark) .sk-section { border-color: var(--border); background: var(--card); }
        html:not(.dark) .sk-section-head { border-bottom-color: var(--border); background: linear-gradient(180deg, var(--paper) 0%, var(--card) 100%); }
        html:not(.dark) .sk-section-head h3 { color: var(--foreground); }
        html:not(.dark) .sk-section-titlebox p { color: var(--muted-foreground); }
        html:not(.dark) .sk-add-btn { border-color: var(--accent); background: linear-gradient(180deg, var(--card) 0%, var(--paper) 100%); color: var(--foreground); }
        html:not(.dark) .sk-cred-card { border-color: var(--border); background: linear-gradient(180deg, var(--card) 0%, var(--paper) 100%); }
        html:not(.dark) .sk-cred-card.is-default { background: radial-gradient(circle at top right, rgba(34, 197, 94, 0.08), transparent 34%), linear-gradient(180deg, var(--card) 0%, var(--paper) 100%); border-color: rgba(34, 197, 94, 0.2); }
        html:not(.dark) .sk-cred-name { color: var(--foreground); }
        html:not(.dark) .sk-cred-meta { color: var(--muted-foreground); }
        html:not(.dark) .sk-provider-tag { color: var(--accent); background: rgba(6, 182, 212, 0.06); }
        html:not(.dark) .sk-masked { background: var(--paper); border-color: var(--border); }
        html:not(.dark) .sk-model { background: var(--paper); border-color: var(--border); color: var(--muted-foreground); }
        html:not(.dark) .sk-act-btn { background: var(--card); border-color: var(--border); color: var(--muted-foreground); }
        html:not(.dark) .sk-act-btn:hover { color: var(--foreground); background: rgba(6, 182, 212, 0.06); }
        html:not(.dark) .sk-note { color: var(--muted-foreground); background: linear-gradient(180deg, var(--paper) 0%, rgba(6, 182, 212, 0.06) 100%); border-color: rgba(6, 182, 212, 0.5); }
        html:not(.dark) .sk-toast.success { background: rgba(34, 197, 94, 0.08); color: #16a34a; border-color: rgba(34, 197, 94, 0.15); }
        html:not(.dark) .sk-toast.error { background: rgba(248, 113, 113, 0.08); color: #dc2626; border-color: rgba(248, 113, 113, 0.15); }

        /* ── Test button & status ── */
        .sk-act-test { }
        .sk-act-test:hover { color: #22d3ee; border-color: rgba(34, 211, 238, 0.25); background: rgba(34, 211, 238, 0.08); }
        .sk-act-test.is-testing { opacity: 0.6; cursor: not-allowed; }
        .sk-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(148, 163, 184, 0.3); border-top-color: #22d3ee; border-radius: 50%; animation: sk-spin 0.6s linear infinite; }
        @keyframes sk-spin { to { transform: rotate(360deg); } }
        .sk-test-status { font-size: 9px; display: inline-flex; align-items: center; gap: 3px; margin-right: 4px; }
        .sk-test-ok { color: #4ade80; }
        .sk-test-err { color: #f87171; font-size: 10px; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        html:not(.dark) .sk-test-err { color: #dc2626; }

        @media (max-width: 760px) {
          .sk-head { flex-direction: column; }
          .sk-overview, .sk-list { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
