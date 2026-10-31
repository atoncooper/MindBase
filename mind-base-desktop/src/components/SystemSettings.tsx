/**
 * 系统设置 pane: runtime status, relocatable data directory and the
 * configuration summary. Owns its data loading so the parent only decides
 * visibility. （本地 ASR 配置已迁移到「API 设置」的 ASR 卡片。）
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getConfig } from "../lib/config";
import type { AppConfig } from "../lib/config";
import {
  getDataDir,
  setDataDir,
  resetDataDir,
  pickDirectory,
} from "../lib/data-dir";
import type { DataDirInfo } from "../lib/data-dir";
import { getFfmpegStatus, ffmpegSourceLabel } from "../lib/ffmpeg";
import type { FfmpegProbeResult } from "../lib/ffmpeg";
import { toErrorMessage } from "../lib/updater";
import type { UpdateCheckState } from "../lib/use-update-check";
import UpdateDialog from "./UpdateDialog";
import { getVectorStats } from "../lib/vectors";
import type { VectorStats } from "../lib/vectors";
import { toItem, itemValue } from "../lib/ui-state";
import type { ItemState, Feedback } from "../lib/ui-state";
import { setConfig as persistConfig } from "../lib/config";
import { getThemePreference, setThemePreference } from "../lib/theme";
import type { ThemePreference } from "../lib/theme";

/** Display labels for known theme values; unknown values fall back to the raw string. */
const THEME_LABELS: Record<string, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/** Display labels for known languages; unknown values fall back to the raw string. */
const LANGUAGE_LABELS: Record<string, string> = {
  "zh-CN": "简体中文",
};

/** Outcome of the `test_proxy` command (mirrors the Rust struct). */
interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  detail: string;
}

function themeLabel(theme: string): string {
  return THEME_LABELS[theme] ?? theme;
}

function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language;
}

/** Database readiness is proven by a successful config round-trip. */
function dbBadge(config: ItemState<AppConfig>): ReactNode {
  const className =
    config.status === "ok"
      ? "status status--ok"
      : config.status === "error"
        ? "status status--error"
        : "status";
  const label =
    config.status === "ok" ? "已就绪" : config.status === "error" ? "读取失败" : "检测中…";
  const live = config.status === "loading" ? " status--live" : "";
  return <span className={`${className}${live}`}>{label}</span>;
}

/** Inline text next to the manual check button (never a blocking UI state). */
function manualFeedback(state: UpdateCheckState, onOpenUpdate: () => void): ReactNode {
  if (state.update !== null) {
    return (
      <>
        <span className="hint-text">
          发现新版本 v{state.update.latestVersion}
        </span>
        <button type="button" className="button" onClick={onOpenUpdate}>
          查看更新
        </button>
      </>
    );
  }
  if (state.checking || state.lastSource !== "manual") return null;
  if (state.error !== null) {
    return <span className="hint-text">检查失败：{state.error}</span>;
  }
  return <span className="hint-text">已是最新版本</span>;
}

/** Badge for the ffmpeg row; `null` result means the probe has not landed yet. */
function ffmpegBadge(result: FfmpegProbeResult | null): ReactNode {
  if (result === null) {
    return (
      <span className="status status--live" title="正在检测 FFmpeg">
        检测中…
      </span>
    );
  }
  const { status, error } = result;
  if (status === null) {
    return (
      <span className="status status--error" title={error ?? undefined}>
        未找到
      </span>
    );
  }
  return (
    <span
      className={status.source === "system" ? "status" : "status status--ok"}
      title={status.path}
    >
      {ffmpegSourceLabel(status.source)} (v{status.version})
    </span>
  );
}

interface SystemSettingsProps {
  /** Visibility is owned by the parent tab switcher; state stays mounted. */
  hidden: boolean;
  /** Shared update-check state; the banner in App renders the same object. */
  updateState: UpdateCheckState;
}

function SystemSettings({ hidden, updateState }: SystemSettingsProps) {
  const [version, setVersion] = useState<ItemState<string>>({ status: "loading" });
  const [dataDir, setDataDirState] = useState<ItemState<DataDirInfo>>({ status: "loading" });
  const [config, setConfig] = useState<ItemState<AppConfig>>({ status: "loading" });
  const [ffmpeg, setFfmpeg] = useState<FfmpegProbeResult | null>(null);
  // Relocation controls: copy-existing choice, in-flight flag, last outcome.
  const [migrateExisting, setMigrateExisting] = useState(true);
  const [relocating, setRelocating] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<Feedback>(null);
  // Built-in vector store: read-only facts for the status row.
  const [vectors, setVectors] = useState<ItemState<VectorStats>>({ status: "loading" });
  // 网络代理：草稿（config 就绪后种子一次）、保存与测试的进行中/结果状态。
  const [proxyDraft, setProxyDraft] = useState<{ http: string; https: string } | null>(null);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyFeedback, setProxyFeedback] = useState<Feedback>(null);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // 命令执行开关：默认关闭；保存后下一次工具调用立即生效（工具每次读配置）。
  const [shellFeedback, setShellFeedback] = useState<Feedback>(null);
  // 更新弹窗：手动检查发现新版本时自动弹出；已知更新可经「查看更新」回看。
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  // 武装位：手动检查发起时置位，结果落地（update 非空）即自动开弹窗。
  const [awaitingUpdateDialog, setAwaitingUpdateDialog] = useState(false);

  useEffect(() => {
    if (!awaitingUpdateDialog || updateState.checking) return;
    if (updateState.update !== null) setUpdateDialogOpen(true);
    setAwaitingUpdateDialog(false);
  }, [awaitingUpdateDialog, updateState.checking, updateState.update]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      // Independent resolution: a failing call only marks its own row
      // ("读取失败") and can never take the other rows down with it.
      // A successful config round-trip also proves the SQLite layer is
      // ready (see the 数据库 row).
      const [ver, dir, cfg, vec] = await Promise.allSettled([
        getVersion(),
        getDataDir(),
        getConfig(),
        getVectorStats(),
      ]);
      if (cancelled) return;
      setVersion(toItem(ver));
      setDataDirState(toItem(dir));
      setConfig(toItem(cfg));
      setVectors(toItem(vec));
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 切换主题：立即生效 + 持久化到 AppConfig（镜像由 theme.ts 同步）。 */
  async function changeTheme(pref: ThemePreference): Promise<void> {
    setThemePreference(pref);
    if (config.status !== "ok") return; // 配置未就绪时仅本会话生效
    try {
      const stored = await persistConfig({ ...config.value, theme: pref });
      setConfig({ status: "ok", value: stored });
    } catch (err) {
      setStorageFeedback({ kind: "error", text: `主题保存失败：${toErrorMessage(err)}` });
    }
  }

  useEffect(() => {
    if (config.status === "ok" && proxyDraft === null) {
      setProxyDraft({
        http: config.value.proxyHttp ?? "",
        https: config.value.proxyHttps ?? "",
      });
    }
  }, [config, proxyDraft]);

  /** 保存代理设置：留空归一为 null（直连），后端校验格式并即时生效。 */
  async function handleSaveProxy(): Promise<void> {
    if (config.status !== "ok" || proxyDraft === null) return;
    setProxySaving(true);
    setProxyFeedback(null);
    try {
      const stored = await persistConfig({
        ...config.value,
        proxyHttp: proxyDraft.http.trim() === "" ? null : proxyDraft.http.trim(),
        proxyHttps: proxyDraft.https.trim() === "" ? null : proxyDraft.https.trim(),
      });
      setConfig({ status: "ok", value: stored });
      setProxyDraft({ http: stored.proxyHttp ?? "", https: stored.proxyHttps ?? "" });
      setProxyFeedback({ kind: "ok", text: "✓ 代理设置已保存，对新请求立即生效" });
    } catch (err) {
      setProxyFeedback({ kind: "error", text: `保存失败：${toErrorMessage(err)}` });
    } finally {
      setProxySaving(false);
    }
  }

  /** 用输入框当前值实测代理连通性（无需先保存）。 */
  async function handleTestProxy(): Promise<void> {
    if (proxyDraft === null) return;
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      const result = await invoke<ProxyTestResult>("test_proxy", {
        proxyHttp: proxyDraft.http.trim() === "" ? null : proxyDraft.http.trim(),
        proxyHttps: proxyDraft.https.trim() === "" ? null : proxyDraft.https.trim(),
      });
      setProxyTestResult({ ok: result.ok, text: result.detail });
    } catch (err) {
      setProxyTestResult({ ok: false, text: toErrorMessage(err) });
    } finally {
      setProxyTesting(false);
    }
  }

  /** 切换本机命令执行开关（默认关；仅影响 Agent 的 run_command 工具）。 */
  async function handleToggleShell(enabled: boolean): Promise<void> {
    if (config.status !== "ok") return;
    setShellFeedback(null);
    try {
      const stored = await persistConfig({ ...config.value, shellEnabled: enabled });
      setConfig({ status: "ok", value: stored });
      setShellFeedback({
        kind: "ok",
        text: enabled
          ? "✓ 命令执行已开启：Agent 可在应用数据目录内运行本机命令并读取输出"
          : "✓ 命令执行已关闭",
      });
    } catch (err) {
      setShellFeedback({ kind: "error", text: `保存失败：${toErrorMessage(err)}` });
    }
  }

  useEffect(() => {
    let cancelled = false;

    // Probed separately from bootstrap: it may spawn a subprocess and should
    // never delay the readiness of the rest of the status card.
    void getFfmpegStatus().then((result) => {
      if (!cancelled) setFfmpeg(result);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /** Move the database to the user-picked folder (no-op on picker cancel). */
  async function handleChangeDataDir(): Promise<void> {
    setRelocating(true);
    setStorageFeedback(null);
    try {
      const picked = await pickDirectory("选择新的数据目录");
      if (picked === null) return;
      const info = await setDataDir(picked, migrateExisting);
      setDataDirState({ status: "ok", value: info });
      setStorageFeedback({
        kind: "ok",
        text: `✓ 数据目录已切换，应用立即使用新位置：${info.currentPath}`,
      });
    } catch (err) {
      setStorageFeedback({ kind: "error", text: `切换失败：${toErrorMessage(err)}` });
    } finally {
      setRelocating(false);
    }
  }

  /** Move the database back to the OS-default directory. */
  async function handleResetDataDir(): Promise<void> {
    setRelocating(true);
    setStorageFeedback(null);
    try {
      const info = await resetDataDir(migrateExisting);
      setDataDirState({ status: "ok", value: info });
      setStorageFeedback({
        kind: "ok",
        text: `✓ 已恢复默认数据目录：${info.currentPath}`,
      });
    } catch (err) {
      setStorageFeedback({ kind: "error", text: `恢复失败：${toErrorMessage(err)}` });
    } finally {
      setRelocating(false);
    }
  }

  // 配置摘要读取自 getConfig；本地 ASR 的编辑入口在「API 设置」。

  return (
    <div className="settings-pane" hidden={hidden}>
      <section className="card">
        <h2 className="card__title">
          <span className="card__index">01</span>系统状态
        </h2>
        <dl className="rows">
          <div className="row">
            <dt className="row__label">当前版本</dt>
            <dd className="row__value">{itemValue(version, (value) => value)}</dd>
          </div>
          <div className="row">
            <dt className="row__label">数据目录</dt>
            <dd className="row__value row__value--path">
              {itemValue(dataDir, (value) => value.currentPath)}
            </dd>
          </div>
          <div className="row">
            <dt className="row__label">数据库</dt>
            <dd className="row__value">{dbBadge(config)}</dd>
          </div>
          <div className="row">
            <dt className="row__label">FFmpeg</dt>
            <dd className="row__value">{ffmpegBadge(ffmpeg)}</dd>
          </div>
          <div className="row">
            <dt className="row__label">向量库</dt>
            <dd className="row__value">
              {itemValue(vectors, (stats) => (
                <span className="status status--ok" title={stats.storagePath}>
                  内置 · {stats.count} 条向量
                </span>
              ))}
            </dd>
          </div>
        </dl>
        <div className="card__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={updateState.checking}
            onClick={() => {
              setAwaitingUpdateDialog(true);
              void updateState.check("manual");
            }}
          >
            {updateState.checking ? "检查中…" : "检查更新"}
          </button>
          {manualFeedback(updateState, () => setUpdateDialogOpen(true))}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">02</span>外观
        </h2>
        <div className="cfg-row">
          <span className="cfg-label">主题</span>
          <div className="quiz-type-row">
            {(Object.entries(THEME_LABELS) as [ThemePreference, string][]).map(([pref, label]) => (
              <label key={pref} className="checkbox-row">
                <input
                  type="radio"
                  name="theme"
                  checked={getThemePreference() === pref}
                  onChange={() => void changeTheme(pref)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <p className="hint-text">
          「跟随系统」随操作系统的深浅色实时切换；选择立即生效并持久保存。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">03</span>数据存储
        </h2>
        {dataDir.status !== "ok" ? (
          <p className="placeholder">
            {dataDir.status === "loading" ? "加载中…" : "数据目录读取失败"}
          </p>
        ) : (
          <>
            <dl className="rows">
              <div className="row">
                <dt className="row__label">当前目录</dt>
                <dd className="row__value row__value--path">
                  {dataDir.value.currentPath}{" "}
                  <span className={dataDir.value.isCustom ? "status status--info" : "status"}>
                    {dataDir.value.isCustom ? "自定义" : "默认"}
                  </span>
                </dd>
              </div>
              <div className="row">
                <dt className="row__label">系统默认</dt>
                <dd className="row__value row__value--path">{dataDir.value.defaultPath}</dd>
              </div>
            </dl>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={migrateExisting}
                disabled={relocating}
                onChange={(event) => setMigrateExisting(event.target.checked)}
              />
              迁移现有数据（取消勾选则在新位置创建空数据库）
            </label>
            <div className="card__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={relocating}
                onClick={() => void handleChangeDataDir()}
              >
                {relocating ? "处理中…" : "更改位置…"}
              </button>
              <button
                type="button"
                className="button"
                disabled={relocating || !dataDir.value.isCustom}
                onClick={() => void handleResetDataDir()}
              >
                恢复默认位置
              </button>
            </div>
            {storageFeedback !== null && (
              <p className={storageFeedback.kind === "error" ? "error-text" : "hint-text"}>
                {storageFeedback.text}
              </p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">04</span>网络代理
        </h2>
        {proxyDraft === null ? (
          <p className="placeholder">
            {config.status === "loading" ? "加载中…" : "配置读取失败"}
          </p>
        ) : (
          <>
            <div className="cfg-row cfg-row--wide">
              <span className="cfg-label">HTTP 代理地址</span>
              <input
                className="cfg-input"
                type="text"
                value={proxyDraft.http}
                placeholder="http://127.0.0.1:10808"
                onChange={(event) =>
                  setProxyDraft({ ...proxyDraft, http: event.target.value })
                }
              />
            </div>
            <div className="cfg-row cfg-row--wide">
              <span className="cfg-label">HTTPS 代理地址</span>
              <input
                className="cfg-input"
                type="text"
                value={proxyDraft.https}
                placeholder="socks5://127.0.0.1:10808"
                onChange={(event) =>
                  setProxyDraft({ ...proxyDraft, https: event.target.value })
                }
              />
            </div>
            <div className="card__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={proxySaving}
                onClick={() => void handleSaveProxy()}
              >
                {proxySaving ? "保存中…" : "保存"}
              </button>
              <button
                type="button"
                className="button"
                disabled={
                  proxyTesting ||
                  (proxyDraft.http.trim() === "" && proxyDraft.https.trim() === "")
                }
                onClick={() => void handleTestProxy()}
              >
                {proxyTesting ? "测试中…" : "测试连接"}
              </button>
              {proxyTestResult !== null && (
                <span className={proxyTestResult.ok ? "hint-text" : "error-text"}>
                  {proxyTestResult.text}
                </span>
              )}
            </div>
            {proxyFeedback !== null && (
              <p className={proxyFeedback.kind === "error" ? "error-text" : "hint-text"}>
                {proxyFeedback.text}
              </p>
            )}
            <p className="hint-text">
              留空时所有外部请求直连；两个地址支持只填一个，未填的协议沿用另一个地址。填写后，外部请求（模型调用、更新检查、模型下载、网页抓取等）优先经代理、失败自动回退直连；
              B 站与 hf-mirror、ModelScope 等国内镜像始终直连。不会读取系统环境变量。
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">05</span>命令执行
        </h2>
        {config.status !== "ok" ? (
          <p className="placeholder">
            {config.status === "loading" ? "加载中…" : "配置读取失败"}
          </p>
        ) : (
          <>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={config.value.shellEnabled === true}
                onChange={(event) => void handleToggleShell(event.target.checked)}
              />
              允许 Agent 在本机执行命令与 git / gh 操作（pwsh / cmd / bash）
            </label>
            <p className="hint-text">
              默认关闭。开启后 Agent 可在应用数据目录内运行命令并读取输出（git / npm / cargo / python 等），也可通过 git / gh 工具对指定仓库执行结构化操作（git 需安装 git；gh 需安装 GitHub CLI 并 gh auth login）。
              普通命令继承当前用户权限，工具层只限制工作目录、超时与输出大小，不是操作系统级沙箱；
              需要真正隔离时用 run_sandboxed：Windows 走 AppContainer（默认断网、只能读写沙箱目录；
              需要联网传 network=on）、Linux 走 bubblewrap、macOS 走 seatbelt。
              每次执行记录到数据目录的 logs/shell-audit.jsonl。
            </p>
            {shellFeedback !== null && (
              <p className={shellFeedback.kind === "error" ? "error-text" : "hint-text"}>
                {shellFeedback.text}
              </p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">06</span>配置摘要
        </h2>
        {config.status !== "ok" ? (
          <p className="placeholder">
            {config.status === "loading" ? "加载中…" : "配置读取失败"}
          </p>
        ) : (
          <dl className="rows">
            <div className="row">
              <dt className="row__label">主题</dt>
              <dd className="row__value">{themeLabel(config.value.theme)}</dd>
            </div>
            <div className="row">
              <dt className="row__label">语言</dt>
              <dd className="row__value">{languageLabel(config.value.language)}</dd>
            </div>
            <div className="row">
              <dt className="row__label">自动检查更新</dt>
              <dd className="row__value">
                <span className={config.value.autoCheckUpdates ? "status status--ok" : "status"}>
                  {config.value.autoCheckUpdates ? "已开启" : "已关闭"}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt className="row__label">命令执行</dt>
              <dd className="row__value">
                <span className={config.value.shellEnabled ? "status status--ok" : "status"}>
                  {config.value.shellEnabled ? "已开启" : "已关闭"}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt className="row__label">网络代理</dt>
              <dd className="row__value">
                {config.value.proxyHttp || config.value.proxyHttps ? (
                  <span
                    className="status status--info"
                    title={[config.value.proxyHttp, config.value.proxyHttps]
                      .filter(Boolean)
                      .join(" / ")}
                  >
                    已启用
                  </span>
                ) : (
                  <span className="status">直连</span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* 弹窗只属于系统设置：pane 转 hidden（切走 tab）时一并消失；
          经 createPortal 渲染到 body，不受 hidden 祖先影响，因此显式门控。 */}
      {!hidden && updateDialogOpen && updateState.update !== null && (
        <UpdateDialog
          info={updateState.update}
          onClose={() => setUpdateDialogOpen(false)}
          onDismiss={() => {
            setUpdateDialogOpen(false);
            updateState.dismiss();
          }}
        />
      )}
    </div>
  );
}

export default SystemSettings;
