//! SFTP 文件面板：远端目录浏览、上传/下载、新建目录与删除文件（纯展示）。

import type { SshSessionInfo } from "../../../lib/ssh";
import { formatBytes, formatRemoteTime } from "./shared";
import type { SftpController } from "./useSftp";

/** 文件夹图标（单色，跟随时文字色）。 */
function FolderGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M1.8 4.2h4.2l1.3 1.5h6.9v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.2z" />
    </svg>
  );
}

/** 文件图标。 */
function FileGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
      <path d="M9.2 1.8V5h3.3" />
    </svg>
  );
}

export interface SftpPanelProps {
  /** 当前是否停留在「文件」tab（隐藏但保持挂载）。 */
  active: boolean;
  session: SshSessionInfo | null;
  sftp: SftpController;
}

export default function SftpPanel({ active, session, sftp }: SftpPanelProps) {
  const {
    sftpPath,
    sftpPathDraft,
    sftpEntries,
    sftpLoading,
    sftpBusy,
    sftpError,
    sftpNotice,
    newDirOpen,
    newDirName,
    setSftpPathDraft,
    setNewDirName,
    loadSftp,
    enterSftpDirectory,
    goSftpParent,
    handleSftpUpload,
    handleSftpDownload,
    handleSftpMkdir,
    handleSftpDelete,
    toggleNewDir,
    cancelNewDir,
  } = sftp;

  return (
    <div className="remote-tabpane remote-files" hidden={!active}>
      {session === null ? (
        <div className="remote-tabpane__empty">
          <p className="remote-tabpane__empty-title">未连接</p>
          <p className="remote-tabpane__empty-text">
            连接服务器后可浏览远端目录、上传 / 下载文件、新建目录与删除文件（SFTP）。
          </p>
        </div>
      ) : (
        <>
          <div className="remote-files__bar">
            <button
              type="button"
              className="button"
              disabled={sftpLoading || sftpPath === "/"}
              onClick={goSftpParent}
            >
              上一级
            </button>
            <input
              className="cfg-input remote-files__path"
              type="text"
              value={sftpPathDraft}
              placeholder="远端路径，如 /home/user"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSftpPathDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void loadSftp(sftpPathDraft);
                }
              }}
            />
            <button
              type="button"
              className="button"
              disabled={sftpLoading}
              onClick={() => void loadSftp(sftpPathDraft)}
            >
              {sftpLoading ? "加载中…" : "刷新"}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={sftpBusy}
              onClick={() => void handleSftpUpload()}
            >
              上传
            </button>
            <button type="button" className="button" disabled={sftpBusy} onClick={toggleNewDir}>
              新建目录
            </button>
          </div>
          {newDirOpen && (
            <div className="remote-files__bar remote-files__newdir">
              <input
                className="cfg-input"
                type="text"
                value={newDirName}
                placeholder="新目录名称"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(event) => setNewDirName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSftpMkdir();
                  }
                }}
              />
              <button
                type="button"
                className="button button--primary"
                disabled={sftpBusy || newDirName.trim() === ""}
                onClick={() => void handleSftpMkdir()}
              >
                创建
              </button>
              <button type="button" className="button" disabled={sftpBusy} onClick={cancelNewDir}>
                取消
              </button>
            </div>
          )}
          {sftpError !== null && <p className="error-text">{sftpError}</p>}
          {sftpNotice !== null && <p className="hint-text">{sftpNotice}</p>}
          <div className="remote-files__list">
            {sftpLoading ? (
              <p className="remote-files__empty">加载中…</p>
            ) : (
              <>
                {sftpPath !== "/" && (
                  <div
                    className="remote-files__row remote-files__row--dir"
                    role="button"
                    tabIndex={0}
                    onClick={goSftpParent}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        goSftpParent();
                      }
                    }}
                  >
                    <span className="remote-files__name">
                      <FolderGlyph /> ..
                    </span>
                    <span className="remote-files__size">—</span>
                    <span className="remote-files__time">—</span>
                    <span className="remote-files__actions" />
                  </div>
                )}
                {sftpEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className={
                      entry.isDir
                        ? "remote-files__row remote-files__row--dir"
                        : "remote-files__row"
                    }
                    role={entry.isDir ? "button" : undefined}
                    tabIndex={entry.isDir ? 0 : undefined}
                    onClick={() => enterSftpDirectory(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        enterSftpDirectory(entry);
                      }
                    }}
                  >
                    <span className="remote-files__name" title={entry.path}>
                      {entry.isDir ? <FolderGlyph /> : <FileGlyph />}
                      {entry.name}
                    </span>
                    <span className="remote-files__size">
                      {entry.isDir ? "—" : formatBytes(entry.size)}
                    </span>
                    <span className="remote-files__time">
                      {formatRemoteTime(entry.modifiedAt)}
                    </span>
                    <span className="remote-files__actions">
                      {!entry.isDir && (
                        <>
                          <button
                            type="button"
                            className="button"
                            disabled={sftpBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleSftpDownload(entry);
                            }}
                          >
                            下载
                          </button>
                          <button
                            type="button"
                            className="button"
                            disabled={sftpBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleSftpDelete(entry);
                            }}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {sftpEntries.length === 0 && (
                  <p className="remote-files__empty">目录为空</p>
                )}
              </>
            )}
          </div>
          <p className="hint-text">
            SFTP 单文件上限 200MB；下载会保存到本机，上传要求远端目录已存在。
          </p>
        </>
      )}
    </div>
  );
}
