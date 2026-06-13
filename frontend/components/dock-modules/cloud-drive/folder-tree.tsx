"use client";

import { useState, useRef } from "react";
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, Pencil, Trash2,
} from "lucide-react";
import { cloudApi, type CloudFolderTreeItem } from "@/lib/api";

export default function FolderTreeNode({
  folder,
  selectedId,
  depth,
  onSelect,
  onDelete,
  onRefresh,
}: {
  folder: CloudFolderTreeItem;
  selectedId: number | null;
  depth: number;
  onSelect: (id: number | null) => void;
  onDelete: (folder: CloudFolderTreeItem) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const hasChildren = folder.children && folder.children.length > 0;

  const handleRenameStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(folder.name);
    setRenaming(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRenameConfirm = async () => {
    const name = editName.trim();
    if (!name || name === folder.name) {
      setRenaming(false);
      return;
    }
    try {
      await cloudApi.updateFolder(folder.id, { name });
      onRefresh();
    } catch {
      // Revert on error
    }
    setRenaming(false);
  };

  const handleRenameCancel = () => setRenaming(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleRenameConfirm();
    if (e.key === "Escape") handleRenameCancel();
  };

  return (
    <div className="cd-folder-group">
      <div
        className={`cd-folder-row ${selectedId === folder.id ? "cd-folder-row--active" : ""}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => { if (!renaming) onSelect(folder.id); }}
      >
        {hasChildren ? (
          <button
            className="cd-folder-chevron"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="cd-folder-chevron-placeholder" />
        )}
        <span className="cd-folder-icon">
          {selectedId === folder.id ? <FolderOpen size={15} /> : <Folder size={15} />}
        </span>
        {renaming ? (
          <input
            ref={inputRef}
            className="cd-folder-rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameConfirm}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="cd-folder-name">{folder.name}</span>
        )}
        <span className="cd-folder-count">{folder.videoCount}</span>
        <button
          className="cd-folder-rename"
          title="重命名"
          onClick={handleRenameStart}
        >
          <Pencil size={12} />
        </button>
        <button
          className="cd-folder-del"
          title="删除文件夹"
          onClick={(e) => { e.stopPropagation(); onDelete(folder); }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {hasChildren && expanded &&
        folder.children.map((child, i) => (
          <FolderTreeNode
            key={child.id ?? `folder-${i}`}
            folder={child}
            selectedId={selectedId}
            depth={depth + 1}
            onSelect={onSelect}
            onDelete={onDelete}
            onRefresh={onRefresh}
          />
        ))
      }
    </div>
  );
}
