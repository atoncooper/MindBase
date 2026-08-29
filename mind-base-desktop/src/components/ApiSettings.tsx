/**
 * API 设置 pane: per-provider configuration (key / base URL / model).
 * Owns its data loading so the parent only decides visibility. Raw keys are
 * never displayed - the backend only ever returns masked previews.
 *
 * The ASR block additionally carries the provider-mode switch (云端 API /
 * 本地部署): local mode persists through the app config's `localAsr` block
 * (model / port), the server itself is managed by the Rust side (embedded
 * Python + faster-whisper, auto-installed and auto-started).
 */

import { useEffect, useRef, useState } from "react";
import {
  listProviders,
  saveProviderConfig,
  clearProviderKey,
  setDefaultProvider,
  testProviderConfig,
} from "../lib/api-keys";
import type { ProviderStatus } from "../lib/api-keys";
import { getConfig, setConfig as persistConfig } from "../lib/config";
import type { AppConfig, LocalAsrConfig } from "../lib/config";
import {
  getLocalAsrModelStatus,
  downloadLocalAsrModel,
} from "../lib/local-asr";
import type { LocalAsrModelStatus } from "../lib/local-asr";
import { toErrorMessage } from "../lib/updater";
import BiliAccountCard from "./BiliAccountCard";
import type { ItemState, Feedback } from "../lib/ui-state";

/** Display labels for key providers; unknown providers fall back to the id. */
const PROVIDER_LABELS: Record<string, string> = {
  dashscope: "DashScope（通义百炼）",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek（深度求索）",
  asr: "ASR 语音转写",
  embedding: "向量化 Embedding",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Default OpenAI-compatible endpoints, shown as placeholders. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  asr: "https://dashscope.aliyuncs.com/api/v1",
  embedding: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

/** Well-known model suggestions per provider (free-text is allowed). */
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  dashscope: ["qwen-max", "qwen-plus", "qwen-turbo", "deepseek-v3", "deepseek-r1"],
  openrouter: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.0-flash-001",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  asr: ["paraformer-realtime-v2", "paraformer-realtime-v1", "paraformer-v2", "paraformer-v1", "sensevoice-v1"],
  embedding: [
    "text-embedding-v4",
    "text-embedding-v3",
    "text-embedding-v2",
    "liquid/lfm-2.5-embedding-350m:free",
    "openai/text-embedding-3-small",
    "openai/text-embedding-3-large",
  ],
};

/** Human-readable byte size (模型卡片与选择器共用). */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)}MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)}KB`;
  return `${bytes}B`;
}

/**
 * API 卡片内的小节分组：对话模型走通用 LLM 槽；ASR / 向量化是用途槽，
 * 未配置时自动回退 DashScope 密钥。
 */
const PROVIDER_GROUPS: Array<{
  title: string;
  hint: string;
  providers: string[];
}> = [
  {
    title: "对话模型",
    hint: "聊天问答、会话总结、测验出题等对话类调用",
    providers: ["dashscope", "deepseek", "openrouter"],
  },
  {
    title: "语音转写 ASR",
    hint: "视频入库时的语音转文字。云端模式走 DashScope（未配置 Key 时回退 DashScope 密钥；Base URL 以 wss:// 开头走实时流式，需选 paraformer-realtime-* 模型）；本地模式由本应用自动下载模型并启动本地服务，无需任何 API Key",
    providers: ["asr"],
  },
  {
    title: "向量化 Embedding",
    hint: "知识库入库与检索的向量化；支持任意 OpenAI 兼容 Embedding 端点（DashScope/OpenRouter/OpenAI 等）。Base URL 留空用 DashScope 默认，未配置时回退 DashScope 密钥",
    providers: ["embedding"],
  },
];

/** Draft form state for one provider. */
interface ProviderDraft {
  key: string;
  baseUrl: string;
  model: string;
}

/** Eye glyph for the visibility toggle (hidden state). */
function EyeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Eye-off glyph for the visibility toggle (visible state). */
function EyeOffIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9.9 4.24A9.5 9.5 0 0 1 12 4c6.5 0 10 8 10 8a17.4 17.4 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A13.9 13.9 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.39-1.61" />
      <path d="m2 2 20 20" />
      <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
    </svg>
  );
}

function draftFrom(status: ProviderStatus): ProviderDraft {
  return { key: "", baseUrl: status.baseUrl, model: status.model };
}

/** True when the form holds nothing worth sending to the backend. */
function draftIsEmpty(draft: ProviderDraft | undefined): boolean {
  if (draft === undefined) return true;
  return draft.key.trim() === "" && draft.baseUrl.trim() === "" && draft.model.trim() === "";
}

/** Fallback local-ASR defaults mirroring the Rust `LocalAsrConfig::default`. */
const LOCAL_ASR_DEFAULTS: LocalAsrConfig = {
  enabled: false,
  command: "",
  port: 8765,
  model: "small",
  extraArgs: "",
  readyTimeoutSecs: 300,
};

interface ApiSettingsProps {
  /** Visibility is owned by the parent tab switcher; state stays mounted. */
  hidden: boolean;
}

function ApiSettings({ hidden }: ApiSettingsProps) {
  const [providers, setProviders] = useState<ItemState<ProviderStatus[]>>({ status: "loading" });
  // Per-provider drafts; seeded from the first successful load so empty
  // inputs mean the stored/default value rather than an unknown.
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  // Key visibility is per-provider and resets to masked after each save.
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  // 当前展开编辑的提供方（null = 全部收起；手风琴语义，一次一行）。
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  // 操作结果按提供方行内显示，不共享一条全局提示。
  const [rowFeedback, setRowFeedback] = useState<Record<string, Feedback>>({});
  // App config (for the ASR provider-mode switch); loaded alongside providers.
  const [appConfig, setAppConfig] = useState<ItemState<AppConfig>>({ status: "loading" });
  const [localAsrFeedback, setLocalAsrFeedback] = useState<Feedback>(null);
  // 自动保存去抖定时器（本地 ASR 文本输入 500ms 合并写库；切换即时保存）。
  const localAsrTimer = useRef<number | null>(null);
  // 本地 ASR 模型下载状态（面板可见时每 2s 轮询，驱动进度条）。
  const [modelStatuses, setModelStatuses] = useState<ItemState<LocalAsrModelStatus[]>>({
    status: "loading",
  });
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void listProviders().then(
      (statuses) => {
        if (cancelled) return;
        setProviders({ status: "ok", value: statuses });
        // Seed missing drafts without clobbering ones already being edited.
        setDrafts((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const entry of statuses) {
            if (next[entry.provider] === undefined) {
              next[entry.provider] = draftFrom(entry);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      (err) => {
        if (cancelled) return;
        console.warn("[api-keys] failed to load provider config", toErrorMessage(err));
        setProviders({ status: "error" });
      },
    );

    void getConfig().then(
      (cfg) => {
        if (!cancelled) setAppConfig({ status: "ok", value: cfg });
      },
      (err) => {
        if (!cancelled) {
          console.warn("[api-keys] failed to load app config", toErrorMessage(err));
          setAppConfig({ status: "error" });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist the whole local-ASR block (enabled + model + port) and surface
   *  the save result on the ASR row's feedback line. */
  async function persistLocalAsr(next: LocalAsrConfig): Promise<void> {
    setLocalAsrFeedback(null);
    try {
      const base =
        appConfig.status === "ok"
          ? appConfig.value
          : await getConfig();
      const saved = await persistConfig({
        ...base,
        localAsr: next,
      });
      setAppConfig({ status: "ok", value: saved });
      setLocalAsrFeedback({ kind: "ok", text: "✓ 已保存" });
    } catch (err) {
      setLocalAsrFeedback({ kind: "error", text: `保存失败：${toErrorMessage(err)}` });
    }
  }

  /** Patch one field of the local ASR config; the enable switch saves
   *  immediately, text inputs debounce 500ms. */
  function patchLocalAsr(patch: Partial<LocalAsrConfig>, immediate = false): void {
    if (appConfig.status !== "ok") return;
    const current = appConfig.value.localAsr ?? LOCAL_ASR_DEFAULTS;
    const next: LocalAsrConfig = {
      ...current,
      ...patch,
      // model falls back to "small" when emptied (backend normalizes too).
      model: (patch.model ?? current.model).trim() || "small",
      port: Number(patch.port ?? current.port) || 8765,
    };
    setAppConfig({ status: "ok", value: { ...appConfig.value, localAsr: next } });
    if (localAsrTimer.current !== null) window.clearTimeout(localAsrTimer.current);
    if (immediate) {
      void persistLocalAsr(next);
    } else {
      localAsrTimer.current = window.setTimeout(() => void persistLocalAsr(next), 500);
    }
  }

  // 卸载时清理未触发的去抖定时器。
  useEffect(() => {
    return () => {
      if (localAsrTimer.current !== null) window.clearTimeout(localAsrTimer.current);
    };
  }, []);

  // 本地 ASR 模型状态轮询：面板可见时每 2s 刷新一次（驱动下载进度条）。
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = (): void => {
      void getLocalAsrModelStatus().then(
        (list) => {
          if (cancelled) return;
          setModelStatuses({ status: "ok", value: list });
          timer = window.setTimeout(tick, 2000);
        },
        () => {
          if (cancelled) return;
          setModelStatuses({ status: "error" });
        },
      );
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [hidden]);

  function updateDraft(provider: string, patch: Partial<ProviderDraft>): void {
    setDrafts((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] ?? { key: "", baseUrl: "", model: "" }), ...patch },
    }));
  }

  /** Save one provider's key + base URL + model in a single round-trip. */
  async function handleSave(provider: string): Promise<void> {
    const draft = drafts[provider];
    if (draft === undefined || draftIsEmpty(draft)) return;
    setBusyProvider(provider);
    setRowFeedback((prev) => ({ ...prev, [provider]: null }));
    try {
      const statuses = await saveProviderConfig(provider, {
        key: draft.key,
        baseUrl: draft.baseUrl,
        model: draft.model,
      });
      setProviders({ status: "ok", value: statuses });
      const saved = statuses.find((entry) => entry.provider === provider);
      if (saved !== undefined) {
        // Re-seed from the authoritative response (trimmed values inside).
        setDrafts((prev) => ({ ...prev, [provider]: draftFrom(saved) }));
      }
      // The credential is stored now - mask it again.
      setShowKeys((prev) => ({ ...prev, [provider]: false }));
      const mask = saved?.maskedKey !== undefined && saved.maskedKey !== null ? ` · ${saved.maskedKey}` : "";
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "ok", text: `✓ 已保存到本地数据库${mask}` },
      }));
    } catch (err) {
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "error", text: `保存失败：${toErrorMessage(err)}` },
      }));
    } finally {
      setBusyProvider(null);
    }
  }

  /** Clear one provider's stored key, keeping base URL / model. */
  async function handleClearKey(provider: string): Promise<void> {
    setBusyProvider(provider);
    setRowFeedback((prev) => ({ ...prev, [provider]: null }));
    try {
      const statuses = await clearProviderKey(provider);
      setProviders({ status: "ok", value: statuses });
      setDrafts((prev) => ({ ...prev, [provider]: { ...prev[provider], key: "" } }));
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: {
          kind: "ok",
          text: "✓ 已清除 API Key（Base URL 与模型保留）",
        },
      }));
    } catch (err) {
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "error", text: `清除失败：${toErrorMessage(err)}` },
      }));
    } finally {
      setBusyProvider(null);
    }
  }

  /** 把该提供方设为对话默认；刷新状态以点亮「默认」徽标。 */
  async function handleSetDefault(provider: string): Promise<void> {
    setBusyProvider(provider);
    setRowFeedback((prev) => ({ ...prev, [provider]: null }));
    try {
      const statuses = await setDefaultProvider(provider);
      setProviders({ status: "ok", value: statuses });
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "ok", text: "✓ 已设为对话默认提供方" },
      }));
    } catch (err) {
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "error", text: `设置失败：${toErrorMessage(err)}` },
      }));
    } finally {
      setBusyProvider(null);
    }
  }

  /**
   * Probe the *stored* configuration (unsaved draft edits are not tested -
   * save first). Success/failure renders through the shared feedback line.
   */
  async function handleTest(provider: string): Promise<void> {
    setBusyProvider(provider);
    setRowFeedback((prev) => ({ ...prev, [provider]: null }));
    try {
      const result = await testProviderConfig(provider);
      if (result.ok) {
        // ASR / embedding perform an end-to-end probe (key + endpoint +
        // model + a real transcription / embedding call); their detail
        // already carries the full verdict.
        const text =
          result.asrNote !== undefined || result.embeddingNote !== undefined
            ? `✓ ${result.detail}`
            : `✓ 连接成功 · ${result.latencyMs}ms${
                result.modelCount !== null ? `，端点返回 ${result.modelCount} 个模型` : ""
              }`;
        setRowFeedback((prev) => ({
          ...prev,
          [provider]: { kind: "ok", text },
        }));
      } else {
        const status = result.httpStatus !== null ? `（HTTP ${result.httpStatus}）` : "";
        setRowFeedback((prev) => ({
          ...prev,
          [provider]: { kind: "error", text: `测试失败：${result.detail}${status}` },
        }));
      }
    } catch (err) {
      setRowFeedback((prev) => ({
        ...prev,
        [provider]: { kind: "error", text: `测试失败：${toErrorMessage(err)}` },
      }));
    } finally {
      setBusyProvider(null);
    }
  }

  function toggleKeyVisibility(provider: string): void {
    setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }));
  }

  /** 启动一个本地 ASR 模型的后台下载；进度由 2s 轮询的 status 驱动。 */
  async function handleDownloadModel(model: string): Promise<void> {
    setDownloadingModel(model);
    try {
      await downloadLocalAsrModel(model);
    } catch (err) {
      setRowFeedback((prev) => ({
        ...prev,
        __localModel: { kind: "error", text: `下载启动失败：${toErrorMessage(err)}` },
      }));
    } finally {
      setDownloadingModel(null);
    }
  }

  /** 「本地 ASR 模型」卡片：每个模型一行，含状态徽标 / 下载进度 / 下载按钮。 */
  function renderLocalAsrModelCard(): React.JSX.Element {
    const downloadNote = rowFeedback["__localModel"] ?? null;
    return (
      <section className="card">
        <h2 className="card__title">
          <span className="card__index">03</span>本地 ASR 模型
        </h2>
        {modelStatuses.status !== "ok" ? (
          <p className="placeholder">
            {modelStatuses.status === "loading" ? "加载中…" : "模型状态读取失败"}
          </p>
        ) : (
          <>
            <p className="card-hint">
              模型下载到本机数据目录后即可在上方 ASR 的「本地部署」中选择使用；下载支持断点续传，失败后可重新点击。
            </p>
            <div className="model-list">
              {modelStatuses.value.map((entry) => {
                const busy = downloadingModel !== null || entry.downloading;
                const percent =
                  entry.downloading && entry.totalBytes > 0
                    ? Math.min(100, Math.round((entry.downloadedBytes / entry.totalBytes) * 100))
                    : null;
                return (
                  <div className="model-item" key={entry.model}>
                    <div className="model-item__info">
                      <span className="model-item__name">{entry.model}</span>
                      <span className="model-item__meta">
                        {entry.label} · 约 {formatBytes(entry.approxSizeBytes)}
                      </span>
                    </div>
                    <div className="model-item__state">
                      {entry.downloaded ? (
                        <span className="status status--ok">已下载</span>
                      ) : entry.downloading ? (
                        <span className="status status--info">
                          {percent !== null ? `下载中 ${percent}%` : "下载中…"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={() => void handleDownloadModel(entry.model)}
                        >
                          下载
                        </button>
                      )}
                    </div>
                    {entry.downloading && (
                      <div
                        className="model-item__progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent ?? undefined}
                      >
                        <div
                          className="model-item__progress-fill"
                          style={{ width: `${percent ?? 0}%` }}
                        />
                      </div>
                    )}
                    {entry.error !== null && !entry.downloading && (
                      <p className="error-text">上次下载失败：{entry.error}（可重试）</p>
                    )}
                  </div>
                );
              })}
            </div>
            {downloadNote !== null && (
              <p className={downloadNote.kind === "error" ? "error-text" : "hint-text"}>
                {downloadNote.text}
              </p>
            )}
          </>
        )}
      </section>
    );
  }

  /** ASR 提供方切换：云端 API / 本地部署。 */
  function renderAsrModeSwitch(): React.JSX.Element | null {
    if (appConfig.status !== "ok") return null;
    const localAsr = appConfig.value.localAsr ?? LOCAL_ASR_DEFAULTS;
    const asrStatus = providers.status === "ok"
      ? providers.value.find((entry) => entry.provider === "asr")
      : undefined;
    const hasCloudKey = asrStatus?.hasKey ?? false;

    return (
      <div className="asr-mode-switch">
        <div className="asr-mode-switch__options" role="radiogroup" aria-label="ASR 提供方">
          <button
            type="button"
            role="radio"
            aria-checked={!localAsr.enabled}
            className={`asr-mode-switch__option${!localAsr.enabled ? " is-active" : ""}`}
            onClick={() => patchLocalAsr({ enabled: false }, true)}
          >
            云端 API（DashScope）
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={localAsr.enabled}
            className={`asr-mode-switch__option${localAsr.enabled ? " is-active" : ""}`}
            onClick={() => patchLocalAsr({ enabled: true }, true)}
          >
            本地部署（Whisper）
          </button>
        </div>

        {localAsr.enabled ? (
          <div className="asr-mode-switch__local">
            <div className="cfg-row">
              <span className="cfg-label" id="label-local-asr-model">
                模型
              </span>
              {(() => {
                const statuses = modelStatuses.status === "ok" ? modelStatuses.value : [];
                const downloaded = statuses.filter((s) => s.downloaded).map((s) => s.model);
                const current = localAsr.model;
                // 只允许选择已下载的模型；当前配置的模型尚未下载时保留展示
                // （标注「未下载」），入库时后端也会拦截并给出明确提示。
                const options =
                  current !== "" && !downloaded.includes(current)
                    ? [current, ...downloaded]
                    : downloaded;
                return (
                  <select
                    className="cfg-input"
                    aria-labelledby="label-local-asr-model"
                    value={options.includes(current) ? current : ""}
                    onChange={(event) => patchLocalAsr({ model: event.target.value }, true)}
                  >
                    {options.length === 0 && <option value="">（尚无已下载模型）</option>}
                    {options.map((model) => {
                      const isDownloaded = downloaded.includes(model);
                      const hints: Record<string, string> = {
                        tiny: "最快，精度低",
                        base: "快",
                        small: "推荐，速度精度均衡",
                        medium: "更准，较慢",
                        "large-v3": "最准，CPU 上很慢",
                      };
                      const hint = hints[model] ?? "";
                      return (
                        <option value={model} key={model}>
                          {model}
                          {isDownloaded ? "" : "（未下载）"}
                          {hint !== "" ? ` · ${hint}` : ""}
                        </option>
                      );
                    })}
                  </select>
                );
              })()}
            </div>
            <div className="cfg-row">
              <span className="cfg-label" id="label-local-asr-port">
                端口
              </span>
              <input
                className="cfg-input cfg-input--narrow"
                type="number"
                aria-labelledby="label-local-asr-port"
                value={localAsr.port}
                onChange={(event) => patchLocalAsr({ port: Number(event.target.value) || 8765 })}
              />
            </div>
            <p className="hint-text">
              仅可选择已下载的模型。首次使用会自动安装运行依赖（约 1-2 分钟）；应用启动时自动拉起本地服务、退出时停止。模型在下方「本地
              ASR 模型」卡片中下载，无需任何云端 API Key。
            </p>
            {localAsrFeedback !== null && (
              <p className={localAsrFeedback.kind === "error" ? "error-text" : "hint-text"}>
                {localAsrFeedback.text}
              </p>
            )}
          </div>
        ) : (
          !hasCloudKey && (
            <p className="hint-text">
              尚未配置云端 ASR 的 API Key。填写下方 Key，或切换到「本地部署」用本地模型转写。
            </p>
          )
        )}
      </div>
    );
  }

  /** 渲染一行档案索引：收起态即状态摘要，展开即内联编辑表单。 */
  function renderProviderRow(entry: ProviderStatus, index: number): React.JSX.Element {
    const draft = drafts[entry.provider];
    const showKey = showKeys[entry.provider] ?? false;
    const open = openProvider === entry.provider;
    const busy = busyProvider !== null;
    const group =
      PROVIDER_GROUPS.find((candidate) => candidate.providers.includes(entry.provider))?.title ?? "";
    const note = rowFeedback[entry.provider] ?? null;
    const modelText = draft?.model.trim() ?? "";
    const headId = `ledger-head-${entry.provider}`;
    const panelId = `ledger-panel-${entry.provider}`;
    const isAsr = entry.provider === "asr";
    const localEnabled = appConfig.status === "ok" && (appConfig.value.localAsr?.enabled ?? false);

    return (
      <div key={entry.provider} className={open ? "ledger-row is-open" : "ledger-row"}>
        <button
          type="button"
          className="ledger-row__head"
          id={headId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpenProvider(open ? null : entry.provider)}
        >
          <span className="ledger-row__index" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="ledger-row__id">
            <span className="ledger-row__name">{providerLabel(entry.provider)}</span>
            {group !== "" && <span className="ledger-row__group">{group}</span>}
          </span>
          <span className="ledger-row__state">
            {isAsr && (
              <span className={localEnabled ? "status status--ok" : "status status--info"}>
                {localEnabled ? "本地部署" : "云端"}
              </span>
            )}
            {modelText !== "" && (
              <span className="ledger-row__model" title={`模型 ${modelText}`}>
                {modelText}
              </span>
            )}
            {isAsr && localEnabled ? (
              <span className="ledger-row__unset">无需 Key</span>
            ) : entry.hasKey ? (
              <code className="ledger-row__mask">{entry.maskedKey ?? "已配置"}</code>
            ) : (
              <span className="ledger-row__unset">未配置</span>
            )}
            {entry.isDefault && <span className="ledger-row__badge">默认</span>}
            <span className="ledger-row__chevron" aria-hidden="true">
              ›
            </span>
          </span>
        </button>

        <div className="ledger-row__panel" id={panelId} role="region" aria-labelledby={headId}>
          <div className="ledger-row__panel-inner">
            {isAsr && renderAsrModeSwitch()}

            {!isAsr || !localEnabled ? (
              <>
                <div className="cfg-row">
                  <span className="cfg-label" id={`label-key-${entry.provider}`}>
                    API Key
                  </span>
                  <input
                    type={showKey ? "text" : "password"}
                    className="cfg-input"
                    aria-labelledby={`label-key-${entry.provider}`}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={entry.hasKey ? "已保存--留空保持不变" : "粘贴 API Key…"}
                    value={draft?.key ?? ""}
                    disabled={busy}
                    onChange={(event) => updateDraft(entry.provider, { key: event.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    title={showKey ? "隐藏" : "显示"}
                    disabled={busy}
                    onClick={() => toggleKeyVisibility(entry.provider)}
                  >
                    {showKey ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>

                <div className="cfg-row">
                  <span className="cfg-label" id={`label-url-${entry.provider}`}>
                    Base URL
                  </span>
                  <input
                    type="text"
                    className="cfg-input"
                    aria-labelledby={`label-url-${entry.provider}`}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={DEFAULT_BASE_URLS[entry.provider] ?? "默认端点"}
                    value={draft?.baseUrl ?? ""}
                    disabled={busy}
                    onChange={(event) => updateDraft(entry.provider, { baseUrl: event.target.value })}
                  />
                </div>

                <div className="cfg-row">
                  <span className="cfg-label" id={`label-model-${entry.provider}`}>
                    模型
                  </span>
                  <input
                    type="text"
                    className="cfg-input"
                    aria-labelledby={`label-model-${entry.provider}`}
                    autoComplete="off"
                    spellCheck={false}
                    list={`model-suggestions-${entry.provider}`}
                    placeholder={`如 ${MODEL_SUGGESTIONS[entry.provider]?.[0] ?? "qwen-max"}，留空用默认`}
                    value={draft?.model ?? ""}
                    disabled={busy}
                    onChange={(event) => updateDraft(entry.provider, { model: event.target.value })}
                  />
                  <datalist id={`model-suggestions-${entry.provider}`}>
                    {(MODEL_SUGGESTIONS[entry.provider] ?? []).map((model) => (
                      <option value={model} key={model} />
                    ))}
                  </datalist>
                </div>
              </>
            ) : null}

            <div className="cfg-actions">
              {!isAsr || !localEnabled ? (
                <>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || draftIsEmpty(draft)}
                    onClick={() => void handleSave(entry.provider)}
                  >
                    {busyProvider === entry.provider ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !entry.hasKey}
                    title={
                      entry.hasKey
                        ? `探测 ${DEFAULT_BASE_URLS[entry.provider] ?? "端点"}/models`
                        : "请先保存 API Key"
                    }
                    onClick={() => void handleTest(entry.provider)}
                  >
                    {busyProvider === entry.provider ? "测试中…" : "测试连接"}
                  </button>
                </>
              ) : null}
              {["dashscope", "deepseek", "openrouter"].includes(entry.provider) && (
                <button
                  type="button"
                  className="button"
                  disabled={busy || entry.isDefault}
                  title="对话界面不手动选择时，优先使用此提供方"
                  onClick={() => void handleSetDefault(entry.provider)}
                >
                  {entry.isDefault ? "已是默认" : "设为默认"}
                </button>
              )}
              <span className="cfg-actions__spacer" />
              {!isAsr || !localEnabled ? (
                entry.hasKey ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void handleClearKey(entry.provider)}
                  >
                    清除密钥
                  </button>
                ) : null
              ) : null}
            </div>

            {note !== null && (
              <p className={note.kind === "error" ? "error-text" : "hint-text"}>{note.text}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-pane" hidden={hidden}>
      <BiliAccountCard />

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">02</span>API 密钥
        </h2>
        {providers.status !== "ok" ? (
          <p className="placeholder">
            {providers.status === "loading" ? "加载中…" : "配置读取失败"}
          </p>
        ) : providers.value.length === 0 ? (
          <p className="placeholder">暂无可配置项</p>
        ) : (
          <>
            <p className="card-hint">
              全部仅保存在这台电脑的本地数据库中，界面只显示掩码，不会回传任何服务器。
              Base URL 留空使用官方默认端点；ASR / 向量化未配置时回退 DashScope 密钥。
            </p>

            <div className="vault-ledger">{providers.value.map(renderProviderRow)}</div>
          </>
        )}
      </section>

      {renderLocalAsrModelCard()}
    </div>
  );
}

export default ApiSettings;
