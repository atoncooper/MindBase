/**
 * 系统设置 pane: runtime status, relocatable data directory and the
 * configuration summary. Owns its data loading so the parent only decides
 * visibility. （本地 ASR 配置已迁移到「API 设置」的 ASR 卡片。）
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
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
function manualFeedback(state: UpdateCheckState): ReactNode {
  if (state.update !== null) {
    return (
      <span className="hint-text">
        发现新版本 v{state.update.latestVersion}，可前往下载
      </span>
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
            onClick={() => void updateState.check("manual")}
          >
            {updateState.checking ? "检查中…" : "检查更新"}
          </button>
          {manualFeedback(updateState)}
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
          <span className="card__index">04</span>配置摘要
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
          </dl>
        )}
      </section>
    </div>
  );
}

export default SystemSettings;
