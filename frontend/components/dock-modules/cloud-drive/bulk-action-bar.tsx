"use client";

import { Database, Trash2, X } from "lucide-react";

export default function CloudDriveBulkBar({
  count,
  onClear,
  onBulkProcess,
  onBulkDelete,
  processDisabled,
}: {
  count: number;
  onClear: () => void;
  onBulkProcess: () => void;
  onBulkDelete: () => void;
  processDisabled: boolean;
}) {
  if (count <= 0) return null;
  return (
    <div className="cd-bulk-bar" role="toolbar" aria-label="批量操作">
      <button
        type="button"
        className="cd-btn-icon"
        onClick={onClear}
        title="取消选择"
        aria-label="取消选择"
      >
        <X size={16} />
      </button>
      <span className="cd-bulk-count">已选择 {count} 项</span>
      <div className="cd-bulk-spacer" />
      <button
        type="button"
        className="cd-btn cd-btn-outline"
        onClick={onBulkProcess}
        disabled={processDisabled}
      >
        <Database size={14} />
        <span>批量入库</span>
      </button>
      <button
        type="button"
        className="cd-btn cd-btn-outline cd-bulk-danger"
        onClick={onBulkDelete}
      >
        <Trash2 size={14} />
        <span>批量删除</span>
      </button>
    </div>
  );
}
