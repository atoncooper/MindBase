"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpDown, LayoutGrid, List, Search,
} from "lucide-react";

export type SortField = "name" | "date" | "size";
export type SortDir = "asc" | "desc";
export type ViewMode = "list" | "grid";

const SORT_LABELS: Record<SortField, string> = {
  name: "名称",
  date: "上传时间",
  size: "大小",
};

export default function CloudDriveToolbar({
  query,
  onQueryChange,
  view,
  onViewChange,
  sortField,
  sortDir,
  onSortChange,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  sortField: SortField;
  sortDir: SortDir;
  onSortChange: (field: SortField, dir: SortDir) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const pickSort = (field: SortField) => {
    // Same field → flip direction; otherwise default to descending for
    // date/size (newest/largest first feels right) and ascending for name.
    if (field === sortField) {
      onSortChange(field, sortDir === "asc" ? "desc" : "asc");
    } else {
      onSortChange(field, field === "name" ? "asc" : "desc");
    }
    setMenuOpen(false);
  };

  return (
    <div className="cd-toolbar">
      <div className="cd-search">
        <Search size={16} className="cd-search-icon" />
        <input
          className="cd-search-input"
          type="search"
          placeholder="在云盘中搜索"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="cd-search-clear"
            onClick={() => onQueryChange("")}
            aria-label="清除搜索"
          >
            ×
          </button>
        )}
      </div>

      <div className="cd-toolbar-right">
        <div className="cd-sort-wrap" ref={menuRef}>
          <button
            type="button"
            className="cd-toolbar-btn"
            onClick={() => setMenuOpen((v) => !v)}
            title="排序方式"
          >
            <ArrowUpDown size={14} />
            <span>{SORT_LABELS[sortField]}</span>
            {sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          </button>
          {menuOpen && (
            <div className="cd-sort-menu" role="menu">
              {(Object.keys(SORT_LABELS) as SortField[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="menuitem"
                  className={`cd-sort-item ${f === sortField ? "cd-sort-item--active" : ""}`}
                  onClick={() => pickSort(f)}
                >
                  <span>{SORT_LABELS[f]}</span>
                  {f === sortField &&
                    (sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="cd-view-toggle" role="group" aria-label="视图切换">
          <button
            type="button"
            className={`cd-toolbar-btn cd-view-btn ${view === "list" ? "cd-view-btn--active" : ""}`}
            onClick={() => onViewChange("list")}
            title="列表视图"
          >
            <List size={14} />
          </button>
          <button
            type="button"
            className={`cd-toolbar-btn cd-view-btn ${view === "grid" ? "cd-view-btn--active" : ""}`}
            onClick={() => onViewChange("grid")}
            title="网格视图"
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
