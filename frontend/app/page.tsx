"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import QRLoginModal from "@/components/QRLoginModal";
import PasswordLoginModal from "@/components/PasswordLoginModal";
import DemoFlowModal from "@/components/DemoFlowModal";
import DockBar from "@/components/DockBar";
import DockPanelWrapper from "@/components/DockPanelWrapper";
import ASRViewerModal from "@/components/ASRViewerModal";
import { DockContext } from "@/lib/dock-context";
import { dockModules } from "@/components/dock-modules";
import { UserInfo, chatApi, VectorPageStatusResponse, WorkspacePage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ChatSidebarRenameDialog } from "@/components/chat-sidebar/ChatSidebarRenameDialog";
import { ChatSidebarDeleteDialog } from "@/components/chat-sidebar/ChatSidebarDeleteDialog";
import { useAppStore } from "@/stores/app-store";
import WallpaperBackground from "@/components/WallpaperBackground";
import Launchpad from "@/components/Launchpad";
import DesktopWidget from "@/components/DesktopWidget";
import WidgetLibrary from "@/components/WidgetLibrary";
import { getWidgetType, type WidgetInstance } from "@/lib/widget-registry";
import ThemeToggle from "@/components/ThemeToggle";

export default function Home() {
  const { sessionToken: session, login } = useAuth();
  const [showQRLogin, setShowQRLogin] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
  const [selectedFolderIds, setSelectedFolderIds] = useState<number[]>([]);
  const [workspacePages, setWorkspacePages] = useState<WorkspacePage[]>([]);
  const [externalVectorUpdate, setExternalVectorUpdate] = useState<{
    bvid: string;
    cid: number;
    status: VectorPageStatusResponse;
    version: number;
  } | null>(null);

  // 聊天会话状态（由 Sidebar 和 ChatPanel 共享）
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);

  // Dock 面板状态
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [panelOriginEl, setPanelOriginEl] = useState<HTMLElement | null>(null);

  // 启动台(Launchpad):低频 dock 模块收入此处
  const [isLaunchpadOpen, setIsLaunchpadOpen] = useState(false);
  const launchpadModules = useMemo(
    () => dockModules.filter((m) => m.placement === "launchpad"),
    []
  );

  // 桌面组件实例(可拖拽 / 可拉伸 / 持久化)
  const [widgets, setWidgets] = useState<WidgetInstance[]>([]);
  const [widgetLibOpen, setWidgetLibOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("desktop_widgets");
    if (stored) {
      try {
        setWidgets(JSON.parse(stored));
      } catch {}
    }
  }, []);

  const persistWidgets = (next: WidgetInstance[]) => {
    setWidgets(next);
    localStorage.setItem("desktop_widgets", JSON.stringify(next));
  };

  const addWidget = (type: string) => {
    const wt = getWidgetType(type);
    if (!wt) return;
    const id = `${type}-${Date.now()}`;
    const offset = widgets.length * 24;
    persistWidgets([
      ...widgets,
      {
        id,
        type,
        x: 80 + offset,
        y: 80 + offset,
        width: wt.defaultSize.width,
        height: wt.defaultSize.height,
      },
    ]);
  };

  const updateWidget = (id: string, patch: Partial<WidgetInstance>) => {
    persistWidgets(widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };

  const removeWidget = (id: string) => {
    persistWidgets(widgets.filter((w) => w.id !== id));
  };

  // ASR 弹窗状态
  const [asrModal, setAsrModal] = useState<{
    isOpen: boolean;
    bvid: string;
    cid: number;
    pageIndex: number;
    pageTitle: string;
  }>({ isOpen: false, bvid: "", cid: 0, pageIndex: 0, pageTitle: "" });

  // 历史会话弹窗状态（必须在 page.tsx 最外层渲染，才能突破 Dock 面板的 transform 层叠上下文）
  const [renameDialog, setRenameDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ sessionId: string; title: string } | null>(null);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  // 初始化/恢复聊天会话
  useEffect(() => {
    if (!session) {
      // Logged out: clear session-scoped UI state (mirrors old onLogout)
      setActiveChatSessionId(null);
      setActivePanelId(null);
      setSelectedFolderIds([]);
      setWorkspacePages([]);
      return;
    }
    const init = async () => {
      let cid = localStorage.getItem("bili_chat_session");
      if (!cid) {
        try {
          const res = await chatApi.createSession(session);
          cid = res.chat_session_id;
          localStorage.setItem("bili_chat_session", cid);
        } catch (e) {
          console.error("创建会话失败", e);
          return;
        }
      }
      setActiveChatSessionId(cid);
    };
    init();
  }, [session]);

  const handleCreateSession = useCallback(async () => {
    try {
      const res = await chatApi.createSession();
      const cid = res.chat_session_id;
      localStorage.setItem("bili_chat_session", cid);
      setActiveChatSessionId(cid);
      setActivePanelId("chat"); // auto-open chat panel
    } catch (e) {
      console.error("创建会话失败", e);
    }
  }, []);

  const handleSelectSession = useCallback((cid: string) => {
    localStorage.setItem("bili_chat_session", cid);
    setActiveChatSessionId(cid);
    setActivePanelId("chat"); // auto-open chat panel
  }, []);

  const onLogin = (sid: string, info: UserInfo) => {
    login(sid, info);
    setShowQRLogin(false);
    setShowPasswordLogin(false);
  };

  const onOpenASR = useCallback((bvid: string, cid: number, pageTitle: string, pageIndex: number = 0) => {
    setAsrModal({ isOpen: true, bvid, cid, pageIndex, pageTitle });
  }, []);

  const onCloseASR = useCallback(() => {
    setAsrModal((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handleRenameConfirm = useCallback(async (title: string) => {
    if (!renameDialog) return;
    try {
      await chatApi.updateSession(renameDialog.sessionId, { title });
      setSessionRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("重命名失败", e);
    } finally {
      setRenameDialog(null);
    }
  }, [renameDialog]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteDialog) return;
    try {
      await chatApi.deleteSession(deleteDialog.sessionId);
      setSessionRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("删除失败", e);
    } finally {
      setDeleteDialog(null);
    }
  }, [deleteDialog]);

  const handleVectorizationDone = useCallback((bvid: string, cid: number, status: VectorPageStatusResponse) => {
    setExternalVectorUpdate({
      bvid,
      cid,
      status,
      version: Date.now(),
    });
  }, []);

  const onBuildDone = useCallback(() => {
    useAppStore.getState().incrementStatsKey();
  }, []);

  const onSelectionChange = useCallback((folderIds: number[]) => {
    setSelectedFolderIds(folderIds);
  }, []);

  const onWorkspacePagesChange = useCallback((pages: WorkspacePage[]) => {
    setWorkspacePages(pages);
  }, []);

  const togglePanel = useCallback((id: string, originEl: HTMLElement | null) => {
    setActivePanelId((prev) => {
      if (prev === id) {
        setPanelOriginEl(null);
        return null;
      }
      setPanelOriginEl(originEl);
      return id;
    });
  }, []);

  const closePanel = useCallback(() => {
    setActivePanelId(null);
    setPanelOriginEl(null);
  }, []);

  // Escape 关闭启动台 / 面板
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isLaunchpadOpen) {
        setIsLaunchpadOpen(false);
      } else if (activePanelId) {
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePanelId, closePanel, isLaunchpadOpen]);

  const activeModule = activePanelId
    ? dockModules.find((m) => m.id === activePanelId)
    : null;
  const ActivePanel = activeModule?.panel;

  const refreshSessions = useCallback(() => {
    setSessionRefreshKey((k) => k + 1);
  }, []);

  const dockContextValue = useMemo(
    () => ({
      sessionId: session,
      onBuildDone,
      onSelectionChange,
      onOpenASR,
      externalVectorUpdate,
      workspacePages,
      onWorkspacePagesChange,
      activeChatSessionId,
      onSelectSession: handleSelectSession,
      onCreateSession: handleCreateSession,
      renameDialog,
      setRenameDialog,
      deleteDialog,
      setDeleteDialog,
      sessionRefreshKey,
      refreshSessions,
    }),
    [session, onBuildDone, onSelectionChange, onOpenASR, externalVectorUpdate, workspacePages, onWorkspacePagesChange, activeChatSessionId, handleSelectSession, handleCreateSession, renameDialog, deleteDialog, sessionRefreshKey, refreshSessions]
  );

  return (
    <DockContext.Provider value={dockContextValue}>
      <div className="app-shell">
        {!session && (
          <div style={{ position: "fixed", top: 16, right: 16, zIndex: 20 }}>
            <ThemeToggle />
          </div>
        )}

        <main className="app-main">
          {!session ? (
            <section className="hero">
              <div className="hero-content">
                <span className="hero-kicker">让你的B站收藏夹不再吃灰</span>
                <h1 className="hero-title">把&quot;收藏&quot;变成真正可用的知识</h1>
                <p className="hero-desc">
                  很多人收藏了大量学习视频，却迟迟没看、没整理、也找不到重点。<br />
                  这里把碎片化内容接入 AI：自动提炼、语义检索、对话式回顾，让收藏真正提升效率。
                </p>

                <div className="hero-actions">
                  <button className="btn btn-primary btn-lg" onClick={() => setShowQRLogin(true)}>
                    扫码登录开始构建
                  </button>
                  <button className="btn btn-outline" onClick={() => setShowPasswordLogin(true)}>
                    账号登录
                  </button>
                  <button className="btn btn-outline" onClick={() => setShowDemo(true)}>
                    体验检索流程
                  </button>
                </div>
              </div>

              <div className="hero-features">
                <div className="pipeline-row">
                  {[
                    { icon: "1", title: "同步", desc: "接入收藏夹" },
                    { icon: "2", title: "提炼", desc: "整理要点" },
                    { icon: "3", title: "检索", desc: "语义查找" },
                    { icon: "4", title: "回顾", desc: "对话复习" },
                  ].map((item, i) => (
                    <div key={i} className="pipeline-card">
                      <span className="pipeline-icon">{item.icon}</span>
                      <div className="pipeline-text">
                        <strong>{item.title}</strong>
                        <span>{item.desc}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : (
            <WallpaperBackground
              session={session}
              dimmed={!!activePanelId}
              onAddWidget={() => setWidgetLibOpen(true)}
            />
          )}
        </main>

        {session &&
          widgets.map((w) => (
            <DesktopWidget
              key={w.id}
              instance={w}
              onChange={updateWidget}
              onRemove={removeWidget}
            />
          ))}

        {/* Dock 图标栏（已登录时显示） */}
        {session && (
          <DockBar
            modules={dockModules}
            activePanelId={activePanelId}
            onTogglePanel={togglePanel}
            onOpenLaunchpad={() => {
              closePanel();
              setIsLaunchpadOpen(true);
            }}
          />
        )}

        {/* 动画面板层 */}
        {activeModule && ActivePanel && (
          <DockPanelWrapper
            panelKey={activePanelId ?? "dock-panel"}
            isOpen={!!activePanelId}
            onClose={closePanel}
            title={activeModule.title}
            originEl={panelOriginEl}
            defaultSize={activeModule.defaultSize}
            className={activeModule.id === "chat" ? "chat-panel" : undefined}
          >
            <ActivePanel isOpen={!!activePanelId} onClose={closePanel} />
          </DockPanelWrapper>
        )}

        <Launchpad
          open={isLaunchpadOpen}
          modules={launchpadModules}
          onClose={() => setIsLaunchpadOpen(false)}
          onLaunch={(mod, el) => {
            setIsLaunchpadOpen(false);
            togglePanel(mod.id, el);
          }}
        />

        <WidgetLibrary
          open={widgetLibOpen}
          onClose={() => setWidgetLibOpen(false)}
          onAdd={addWidget}
        />

        <QRLoginModal isOpen={showQRLogin} onClose={() => setShowQRLogin(false)} onSuccess={onLogin} />
        <PasswordLoginModal
          isOpen={showPasswordLogin}
          onClose={() => setShowPasswordLogin(false)}
          onSuccess={onLogin}
          onSwitchToQR={() => { setShowQRLogin(true); }}
        />
        <DemoFlowModal isOpen={showDemo} onClose={() => setShowDemo(false)} />
        {asrModal.isOpen && (
          <ASRViewerModal
            isOpen={asrModal.isOpen}
            onClose={onCloseASR}
            bvid={asrModal.bvid}
            cid={asrModal.cid}
            pageIndex={asrModal.pageIndex}
            pageTitle={asrModal.pageTitle}
            onVectorizationDone={handleVectorizationDone}
          />
        )}
        {/* 历史会话弹窗 — 必须在 app-shell 之外（与 DockPanelWrapper 同级）才能正常显示 */}
        {renameDialog && (
          <ChatSidebarRenameDialog
            open={!!renameDialog}
            currentTitle={renameDialog.title}
            onOpenChange={(open) => {
              if (!open) setRenameDialog(null);
            }}
            onConfirm={handleRenameConfirm}
          />
        )}
        {deleteDialog && (
          <ChatSidebarDeleteDialog
            open={!!deleteDialog}
            sessionTitle={deleteDialog.title}
            onOpenChange={(open) => {
              if (!open) setDeleteDialog(null);
            }}
            onConfirm={handleDeleteConfirm}
          />
        )}
      </div>
    </DockContext.Provider>
  );
}
