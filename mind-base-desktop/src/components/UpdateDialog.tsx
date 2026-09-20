/**
 * 更新弹窗 —— 仅在系统设置中弹出（检查更新发现新版本时自动打开，
 * 已发现的更新可经「查看更新」随时回看）。
 *
 * 更新日志是 GitHub release 的 markdown 正文，经共享 MarkdownContent
 * 渲染（GFM + 链接走 opener 插件）。安装首选签名更新通道
 * （tauri-plugin-updater：校验 + 静默安装 + 自动重启，即无感更新）；
 * 通道不可用时（latest.json 缺失 / 网络失败）自动回退为下载安装包
 * 启动向导的方式。「前往下载」保留为浏览器兜底。
 * 检查逻辑见 `src/lib/use-update-check.ts`。
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { UpdateInfo } from "../lib/updater";
import {
  downloadUpdate,
  runUpdateInstaller,
  toErrorMessage,
  updaterCheck,
  updaterInstall,
} from "../lib/updater";
import { MarkdownContent } from "./chat/MarkdownContent";

/** Open the release page in the default browser; failures stay non-fatal. */
async function openReleasePage(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    console.warn("[update] failed to open release page", toErrorMessage(err));
  }
}

interface UpdateDialogProps {
  /** Update to present. */
  info: UpdateInfo;
  /** Close the dialog but keep the "发现新版本" hint in settings. */
  onClose: () => void;
  /** Dismiss this version: clears the shared update state. */
  onDismiss: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function UpdateDialog({ info, onClose, onDismiss }: UpdateDialogProps): React.JSX.Element {
  // idle → downloading → installing(签名通道) | launching(兜底向导) → done
  //                                                  ↘ failed(message)
  const [phase, setPhase] = useState<
    "idle" | "downloading" | "installing" | "launching" | "done" | "failed"
  >("idle");
  const [progress, setProgress] = useState({ received: 0, total: 0 });
  const [failMessage, setFailMessage] = useState("");
  // 签名更新通道不可用时自动回退安装包流程，这里留一句提示说明原因。
  const [fallbackNote, setFallbackNote] = useState("");

  const notes = info.releaseNotes?.trim() ?? "";
  // The backend whitelists `https://github.com/` URLs; anything untrusted
  // arrives as an empty string and both download actions are hidden.
  const releaseUrl = info.releaseUrl.trim();
  const canDownload = releaseUrl !== "";
  const busy =
    phase === "downloading" || phase === "installing" || phase === "launching";
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : -1;
  const published = info.publishedAt !== null ? new Date(info.publishedAt) : null;

  /** 首选签名更新通道；不可用时回退为下载安装包 + 启动向导。 */
  async function downloadAndInstall(): Promise<void> {
    if (busy) return;
    setPhase("downloading");
    setFailMessage("");
    setFallbackNote("");
    setProgress({ received: 0, total: 0 });
    try {
      const meta = await updaterCheck();
      if (!meta.available) throw new Error("签名更新通道暂无可用版本");
      await updaterInstall((event) => {
        if (event.type === "progress") {
          setProgress({
            received: event.received,
            total: event.totalBytes ?? 0,
          });
        } else {
          setPhase("installing");
        }
      });
      // 成功路径上进程会被安装器接管（Windows）/自动重启（macOS/Linux），
      // 正常到不了这里；保险起见按完成处理。
      setPhase("done");
      return;
    } catch (err) {
      console.warn("[update] signed updater unavailable, falling back to installer", err);
      setFallbackNote("签名更新通道不可用，已改用安装包方式安装。");
    }
    // 兜底：应用内下载 Windows 安装包，完成后启动安装向导。
    setPhase("downloading");
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

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="modal update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="发现新版本"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="update-dialog__head">
          <h2>发现新版本 v{info.latestVersion}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="update-dialog__body">
          <p className="update-dialog__meta">
            当前 v{info.currentVersion}
            {published !== null && !Number.isNaN(published.getTime())
              ? ` · 发布于 ${published.toLocaleDateString()}`
              : ""}
          </p>
          {notes !== "" ? (
            <MarkdownContent content={notes} />
          ) : (
            <p className="hint-text">本次发布未提供更新日志。</p>
          )}
        </div>

        <div className="update-dialog__foot">
          {phase === "downloading" && (
            <div className="ingest__busy" role="status" aria-live="polite">
              <div className={`ingest__bar ${pct < 0 ? "ingest__bar--indeterminate" : ""}`}>
                {pct >= 0 && <div className="ingest__bar__fill" style={{ width: `${pct}%` }} />}
              </div>
              <span className="ingest__busy__text">
                下载更新 {pct >= 0 ? `${pct}% · ` : ""}
                {formatBytes(progress.received)}
                {progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""}
              </span>
            </div>
          )}
          {phase === "installing" && (
            <p className="hint-text">
              更新包已通过签名校验，正在静默安装…完成后应用将自动重启。
            </p>
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
          {fallbackNote !== "" && phase !== "failed" && (
            <p className="hint-text">{fallbackNote}</p>
          )}
          <div className="update-dialog__buttons">
            {canDownload && phase !== "done" && (
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                title="校验签名并静默安装更新，完成后应用自动重启"
                onClick={() => void downloadAndInstall()}
              >
                {busy ? (
                  <>
                    <span className="ingest__spinner" />
                    {phase === "downloading"
                      ? "下载中"
                      : phase === "installing"
                        ? "安装中"
                        : "启动中"}
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
              忽略此版本
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default UpdateDialog;
