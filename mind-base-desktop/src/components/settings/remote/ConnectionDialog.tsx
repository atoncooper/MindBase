//! 连接配置弹窗：复用 ConnectionForm，保存成功 / 删除后自动关闭，取消丢弃草稿。

import { useEffect } from "react";
import ConnectionForm from "./ConnectionForm";
import type { HostsController } from "./useHosts";

export interface ConnectionDialogProps {
  hosts: HostsController;
  /** 取消/关闭（丢弃未保存草稿）。 */
  onClose: () => void;
  /** 保存成功后关闭（保留已保存状态）。 */
  onSaved: () => void;
  /** 删除成功后关闭。 */
  onDeleted: () => void;
}

export default function ConnectionDialog({
  hosts,
  onClose,
  onSaved,
  onDeleted,
}: ConnectionDialogProps) {
  // Esc 关闭（等同取消，丢弃草稿）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const title = hosts.isNew ? "新建会话" : "编辑会话";
  const subtitle =
    hosts.selectedHost !== null
      ? hosts.selectedHost.username + "@" + hosts.selectedHost.host + ":" + hosts.selectedHost.port
      : "";

  return (
    <div
      className="remote-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // 仅点击遮罩本身关闭；点击卡片内部不关闭。
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="remote-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="remote-dialog__head">
          <div className="remote-dialog__titles">
            <h2 className="remote-dialog__title">{title}</h2>
            {subtitle !== "" && <span className="remote-dialog__subtitle">{subtitle}</span>}
          </div>
          <button
            type="button"
            className="remote-dialog__close"
            aria-label="关闭"
            title="关闭（取消未保存修改）"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="remote-dialog__body">
          <ConnectionForm hosts={hosts} embedded onSaved={onSaved} onDeleted={onDeleted} />
        </div>
      </div>
    </div>
  );
}
