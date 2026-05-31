"use client";

import { createContext, useContext } from "react";
import { VectorPageStatusResponse, WorkspacePage } from "./api";

export interface RenameDialogState {
  sessionId: string;
  title: string;
}

export interface DeleteDialogState {
  sessionId: string;
  title: string;
}

export interface DockContextValue {
  sessionId: string | null;
  onBuildDone: () => void;
  onSelectionChange: (folderIds: number[]) => void;
  onOpenASR: (bvid: string, cid: number, pageTitle: string, pageIndex?: number) => void;
  externalVectorUpdate: {
    bvid: string;
    cid: number;
    status: VectorPageStatusResponse;
    version: number;
  } | null;
  workspacePages: WorkspacePage[];
  onWorkspacePagesChange: (pages: WorkspacePage[]) => void;
  activeChatSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => Promise<void>;
  // 历史会话弹窗状态（必须在 page.tsx 最外层渲染才能突破 Dock 面板的 transform 层叠上下文）
  renameDialog: RenameDialogState | null;
  setRenameDialog: (s: RenameDialogState | null) => void;
  deleteDialog: DeleteDialogState | null;
  setDeleteDialog: (s: DeleteDialogState | null) => void;
  sessionRefreshKey: number;
  refreshSessions: () => void;
}

export const DockContext = createContext<DockContextValue | null>(null);

export function useDockContext(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) {
    throw new Error("useDockContext must be used within DockContext.Provider");
  }
  return ctx;
}
