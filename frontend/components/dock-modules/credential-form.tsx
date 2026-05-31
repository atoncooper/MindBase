"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, X } from "lucide-react";
import type { CredentialItem, CredentialCreateParams, CredentialUpdateParams, ConfigCreateParams, ConfigUpdateParams } from "@/lib/api";

/* ──── Provider config ──── */

const LLM_PROVIDERS = [
  { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
  { value: "anthropic", label: "Anthropic", placeholder_url: "https://api.anthropic.com" },
  { value: "deepseek", label: "DeepSeek", placeholder_url: "https://api.deepseek.com" },
  { value: "custom", label: "Custom", placeholder_url: "" },
];

const EMBEDDING_PROVIDERS = [
  { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
  { value: "dashscope", label: "DashScope", placeholder_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { value: "custom", label: "Custom", placeholder_url: "" },
];

const ASR_PROVIDERS = [
  { value: "dashscope", label: "DashScope", placeholder_url: "https://dashscope.aliyuncs.com/api/v1" },
  { value: "openai", label: "OpenAI", placeholder_url: "https://api.openai.com/v1" },
  { value: "custom", label: "Custom", placeholder_url: "" },
];

function getProviders(type: "llm" | "embedding" | "asr") {
  if (type === "llm") return LLM_PROVIDERS;
  if (type === "embedding") return EMBEDDING_PROVIDERS;
  return ASR_PROVIDERS;
}

/* ──── Props ──── */

export interface CredentialFormProps {
  type?: "llm" | "embedding" | "asr";
  credential?: CredentialItem | null;
  onSave: (data: CredentialCreateParams | CredentialUpdateParams | ConfigCreateParams | ConfigUpdateParams) => Promise<void>;
  onCancel: () => void;
}

/* ──── Component ──── */

export default function CredentialForm({ type = "llm", credential, onSave, onCancel }: CredentialFormProps) {
  const isEdit = !!credential;
  const providers = getProviders(type);
  const defaultProvider = type === "asr" ? "dashscope" : "openai";
  const isLLM = type === "llm";

  const [name, setName] = useState(credential?.name || "");
  const [provider, setProvider] = useState(credential?.provider || defaultProvider);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(credential?.base_url || "");
  const [model, setModel] = useState((credential as any)?.default_model || (credential as any)?.model || "");
  const [isDefault, setIsDefault] = useState(credential?.is_default || false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = providers.find(p => p.value === provider);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) { setError("请输入名称"); return; }
    if (!isEdit && !apiKey.trim()) { setError("请输入 API Key"); return; }

    setSaving(true);
    try {
      const base: any = {
        name: name.trim(),
        ...(isEdit ? {} : { provider }),
        ...(apiKey && { api_key: apiKey.trim() }),
        base_url: baseUrl.trim() || selectedProvider?.placeholder_url || "",
        ...(isEdit ? {} : { is_default: isDefault }),
      };
      if (model.trim()) {
        base[isLLM ? "default_model" : "model"] = model.trim();
      }
      await onSave(base);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const formContent = (
    <div className="cf-overlay" onClick={onCancel}>
      <div className="cf-modal" onClick={e => e.stopPropagation()}>
        <div className="cf-head">
          <div>
            <span className="cf-kicker">{isEdit ? "更新配置" : "新增配置"}</span>
            <h3>{isEdit ? "编辑凭证" : "新增凭证"}</h3>
          </div>
          <button className="cf-close" onClick={onCancel}><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit} className="cf-body">
          {/* 名称 */}
          <div className="cf-field">
            <label>名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：我的 OpenAI Key"
              className="cf-input"
              autoFocus
            />
          </div>

          {/* 服务商 */}
          <div className="cf-field">
            <label>服务商</label>
            <select
              value={provider}
              onChange={e => { setProvider(e.target.value); setBaseUrl(""); }}
              className="cf-input cf-select"
            >
              {providers.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="cf-field">
            <label>
              API Key
              {isEdit && !apiKey && <span className="cf-label-tag">保持不变</span>}
            </label>
            <div className="cf-input-wrap">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={isEdit && !apiKey ? "••••••••" : "sk-…"}
                className="cf-input"
              />
              <button type="button" className="cf-eye" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {/* 接口地址 */}
          <div className="cf-field">
            <label>接口地址</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={selectedProvider?.placeholder_url || ""}
              className="cf-input"
            />
          </div>

          {/* 模型 */}
          <div className="cf-field">
            <label>{isLLM ? "默认模型" : "模型"}</label>
            <input
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder={
                !isLLM
                  ? (type === "embedding" ? "text-embedding-3-small" : "paraformer-v2")
                  : (provider === "openai" ? "gpt-4o" : provider === "anthropic" ? "claude-sonnet-4-6" : provider === "deepseek" ? "deepseek-chat" : "")
              }
              className="cf-input"
            />
          </div>

          {/* 设为默认（仅新增时显示） */}
          {!isEdit && (
            <label className="cf-check">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={e => setIsDefault(e.target.checked)}
              />
              <span>设为默认凭证</span>
            </label>
          )}

          {/* Error */}
          {error && <div className="cf-error">{error}</div>}

          {/* Actions */}
          <div className="cf-actions">
            <button type="button" className="cf-btn cf-btn-cancel" onClick={onCancel}>取消</button>
            <button type="submit" className="cf-btn cf-btn-save" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>

      <style jsx>{`
        .cf-overlay {
          position: fixed; inset: 0; z-index: 9999;
          display: flex; align-items: center; justify-content: center;
          background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(10px);
          animation: cfFadeIn .15s ease;
        }
        @keyframes cfFadeIn { from { opacity: 0; } to { opacity: 1; } }

        .cf-modal {
          width: 440px; max-width: 92vw; max-height: 90vh; overflow-y: auto;
          background: linear-gradient(180deg, var(--card) 0%, var(--paper-3) 100%);
          border: 1px solid var(--border);
          border-radius: 20px;
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.25);
          animation: cfSlideUp .2s ease;
        }
        @keyframes cfSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .cf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 22px 0; }
        .cf-kicker {
          display: inline-flex; align-items: center; margin-bottom: 8px;
          padding: 4px 10px; border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 8%, transparent);
          color: var(--accent); font-size: 11px; font-weight: 700;
          letter-spacing: 0.08em; text-transform: uppercase;
        }
        .cf-head h3 { font-size: 18px; font-weight: 700; margin: 0; letter-spacing: -0.02em; color: var(--foreground); }
        .cf-close {
          background: var(--card); border: 1px solid var(--border); cursor: pointer;
          color: var(--muted-foreground); padding: 8px; border-radius: 10px; display: flex;
          transition: color .12s, background .12s, border-color .12s, transform .12s;
        }
        .cf-close:hover {
          color: var(--foreground);
          background: color-mix(in srgb, var(--accent) 8%, transparent);
          border-color: var(--accent);
          transform: translateY(-1px);
        }

        .cf-body { padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 14px; }

        .cf-field { display: flex; flex-direction: column; gap: 6px; }
        .cf-field label {
          font-size: 11px; font-weight: 700; color: var(--muted-foreground);
          text-transform: uppercase; letter-spacing: 0.06em; display: flex; align-items: center; gap: 6px;
        }
        .cf-label-tag {
          font-size: 10px; font-weight: 700; text-transform: none; letter-spacing: 0;
          color: #16a34a; background: rgba(34, 197, 94, 0.1); padding: 1px 6px; border-radius: 3px;
        }

        .cf-input {
          width: 100%; min-height: 44px; padding: 10px 12px;
          border: 1px solid var(--border); border-radius: 12px; font-size: 13px;
          background: var(--paper-3); color: var(--foreground); outline: none;
          transition: border-color .15s, box-shadow .15s, background .15s;
          font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        }
        .cf-input::placeholder { font-family: system-ui, -apple-system, sans-serif; color: var(--muted-foreground); }
        .cf-input:focus {
          border-color: var(--accent-strong); background: var(--card);
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 16%, transparent);
        }
        .cf-select { font-family: system-ui, -apple-system, sans-serif; cursor: pointer; }
        .cf-select option { background: var(--card); color: var(--foreground); }

        .cf-input-wrap { position: relative; display: flex; align-items: center; }
        .cf-input-wrap .cf-input { padding-right: 36px; }
        .cf-eye {
          position: absolute; right: 6px; background: transparent; border: none;
          padding: 6px; cursor: pointer; color: var(--muted-foreground); display: flex; border-radius: 8px;
        }
        .cf-eye:hover { color: var(--foreground); background: color-mix(in srgb, var(--muted-foreground) 12%, transparent); }

        .cf-check {
          display: flex; align-items: center; gap: 8px; font-size: 13px;
          color: var(--muted-foreground); cursor: pointer; padding: 6px 0 2px; font-weight: 600;
        }
        .cf-check input { width: 16px; height: 16px; accent-color: var(--accent); }

        .cf-error {
          font-size: 12.5px; color: #f87171; padding: 10px 12px;
          background: rgba(248, 113, 113, 0.1); border-radius: 12px;
          border: 1px solid rgba(248, 113, 113, 0.2);
        }

        .cf-actions { display: flex; gap: 10px; padding-top: 6px; }
        .cf-btn {
          flex: 1; min-height: 40px; padding: 8px 0; border: none; border-radius: 12px;
          font-size: 12.5px; font-weight: 700; cursor: pointer;
          transition: opacity .15s, background .15s, transform .1s, box-shadow .15s, border-color .15s;
        }
        .cf-btn:active:not(:disabled) { transform: scale(0.98); }
        .cf-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .cf-btn-save {
          flex: 0 0 116px;
          background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 18%, transparent) 0%, color-mix(in srgb, var(--accent) 10%, transparent) 100%);
          color: var(--accent-strong);
          border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
          box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 10%, transparent);
        }
        .cf-btn-save:hover:not(:disabled) {
          background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 24%, transparent) 0%, color-mix(in srgb, var(--accent) 14%, transparent) 100%);
          box-shadow: 0 10px 20px color-mix(in srgb, var(--accent) 14%, transparent);
        }
        .cf-btn-cancel {
          background: var(--card); color: var(--muted-foreground); border: 1px solid var(--border);
        }
        .cf-btn-cancel:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent) 8%, transparent);
          border-color: var(--accent);
        }
      `}</style>
    </div>
  );

  if (typeof window === "undefined") return null;
  return createPortal(formContent, document.body);
}
