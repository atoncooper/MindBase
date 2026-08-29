/**
 * Solid-surface banner announcing a newer desktop release.
 *
 * 「下载并安装」拉起应用内下载（带进度条），完成后自动启动安装向导；
 * 「前往下载」保留为浏览器兜底（例如应用内下载被网络环境阻断时）。
 * 更新内容展示是纯展示：检查逻辑见 `src/lib/use-update-check.ts`。
 */

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { UpdateInfo } from "../lib/updater";
import {
  downloadUpdate,
  runUpdateInstaller,
  toErrorMessage,
} from "../lib/updater";

interface UpdateBannerProps {
  /** Update to present; null renders nothing. */
  info: UpdateInfo | null;
  /** Called when the user dismisses the banner. */
  onDismiss: () => void;
}

/** Open the release page in the default browser; failures stay non-fatal. */
async function openReleasePage(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    console.warn("[update] failed to open release page", toErrorMessage(err));
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function UpdateBanner({ info, onDismiss }: UpdateBannerProps) {
  // idle → downloading(received/total) → launching → done | failed(message)
  const [phase, setPhase] = useState<"idle" | "downloading" | "launching" | "done" | "failed">("idle");
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [failMessage, setFailMessage] = useState("");

  if (info === null) return null;

  const notes = info.releaseNotes?.trim() ?? "";
  // The backend whitelists `https://github.com/` URLs; anything untrusted
  // arrives as an empty string and both download actions are hidden — the
  // banner keeps showing the version information.
  const releaseUrl = info.releaseUrl.trim();
  const canDownload = releaseUrl !== "";
  const busy = phase === "downloading" || phase === "launching";
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : -1;

  /** One-shot: download the installer, then hand off to the setup wizard. */
  async function downloadAndInstall(): Promise<void> {
    if (busy) return;
    setPhase("downloading");
    setFailMessage("");
    setProgress({ received: 0, total: 0 });
    try {
      const summary = await downloadUpdate(releaseUrl, (event) => {
        if (event.type === "start") {
          setProgress({ received: 0, total: event.totalBytes });
        } else if (event.type === "progress") {
          setProgress({ received: event.received, total: event.totalBytes });
        }
      });
      setPhase("launching");
      await runUpdateInstaller(summary.path);
      setPhase("done");
    } catch (err) {
      setFailMessage(toErrorMessage(err));
      setPhase("failed");
    }
  }

  return (
    <section className="card update-banner" role="status">
      <div className="update-banner__body">
        <div className="update-banner__head">
          <span className="status status--info">新版本</span>
          <p className="update-banner__title">
            发现新版本 v{info.latestVersion}（当前 v{info.currentVersion}）
          </p>
        </div>
        {notes !== "" && <p className="update-banner__notes">{notes}</p>}
        {phase === "downloading" && (
          <div className="ingest__busy" role="status" aria-live="polite">
            <div className={`ingest__bar ${pct < 0 ? "ingest__bar--indeterminate" : ""}`}>
              {pct >= 0 && <div className="ingest__bar__fill" style={{ width: `${pct}%` }} />}
            </div>
            <span className="ingest__busy__text">
              下载安装包 {pct >= 0 ? `${pct}% · ` : ""}
              {formatBytes(progress.received)}
              {progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""}
            </span>
          </div>
        )}
        {phase === "launching" && (
          <p className="hint-text">安装包已就绪，正在启动安装向导…</p>
        )}
        {phase === "done" && (
          <p className="hint-text">
            安装向导已启动，按提示完成安装后重新打开应用即可升级。
          </p>
        )}
        {phase === "failed" && <p className="error-text">{failMessage}</p>}
      </div>
      <div className="update-banner__actions">
        {canDownload && phase !== "done" && (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            title="应用内下载 Windows 安装包并启动安装向导"
            onClick={() => void downloadAndInstall()}
          >
            {busy ? (
              <>
                <span className="ingest__spinner" />
                {phase === "downloading" ? "下载中" : "启动中"}
              </>
            ) : phase === "failed" ? (
              "重试下载"
            ) : (
              "下载并安装"
            )}
          </button>
        )}
        {canDownload && (
          <button
            type="button"
            className="button"
            disabled={busy}
            title="在浏览器中打开 GitHub 发布页手动下载"
            onClick={() => void openReleasePage(releaseUrl)}
          >
            前往下载
          </button>
        )}
        <button type="button" className="button" disabled={busy} onClick={onDismiss}>
          忽略
        </button>
      </div>
    </section>
  );
}

export default UpdateBanner;
