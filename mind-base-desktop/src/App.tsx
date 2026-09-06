/**
 * App shell: 左侧细导航栏（NavRail）+ 右侧主显示区。
 *
 * 主区随 hash 路由渲染：home = 对话工作区（全宽 chat 布局）、knowledge =
 * 知识库管理、favorites = 收藏夹、settings 双 tab。纯 in-flow flex 布局。
 */

import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import UpdateBanner from "./components/UpdateBanner";
import SystemSettings from "./components/SystemSettings";
import ApiSettings from "./components/ApiSettings";
import ChatView from "./components/chat/ChatView";
import KnowledgeView from "./components/KnowledgeView";
import ImportView from "./components/import-view/ImportView";
import NotesView from "./components/notes/NotesView";
import QuizView from "./components/quiz/QuizView";
import QuizSetView from "./components/quiz/QuizSetView";
import ResumeView from "./components/resume/ResumeView";
import SlidesView from "./components/slides/SlidesView";
import FavoritesView from "./components/FavoritesView";
import SkillsView from "./components/SkillsView";
import NavRail from "./components/NavRail";
import {
  SETTINGS_API_HASH,
  SETTINGS_SYSTEM_HASH,
  navigate,
  useHashRoute,
} from "./lib/router";
import type { PendingJump, SettingsTab } from "./lib/router";
import { toErrorMessage } from "./lib/updater";
import { useUpdateCheck } from "./lib/use-update-check";
import { initTheme } from "./lib/theme";
import type { ItemState } from "./lib/ui-state";
import CommandPalette from "./components/CommandPalette";

/** Settings groups, in display order. */
const TABS: ReadonlyArray<{ id: SettingsTab; label: string; hash: string }> = [
  { id: "system", label: "系统设置", hash: SETTINGS_SYSTEM_HASH },
  { id: "api", label: "API 设置", hash: SETTINGS_API_HASH },
];

/** Per-view subtitle for the non-chat routes（全幅布局，不再分宽窄栏）。 */
function viewMeta(route: ReturnType<typeof useHashRoute>): { subtitle: string } {
  switch (route.view) {
    case "favorites":
      return { subtitle: "收藏夹" };
    case "knowledge":
      return { subtitle: "知识库管理" };
    case "import":
      return { subtitle: "文件入库" };
    case "quiz":
      return { subtitle: "知识测验" };
    case "quiz-set":
      return { subtitle: "历史题集" };
    case "resume":
      return { subtitle: "简历生成" };
    case "slides":
      return { subtitle: "PPT 制作" };
    case "skills":
      return { subtitle: "技能管理" };
    default:
      return { subtitle: "设置" };
  }
}

function App() {
  const route = useHashRoute();
  const [version, setVersion] = useState<ItemState<string>>({ status: "loading" });
  // One silent auto check ~3s after mount, plus manual checks on demand;
  // the banner and the 系统状态 card share this single state object.
  const updateState = useUpdateCheck(3000);
  const inSettings = route.view === "settings";
  // The chat workspace is full-bleed: it skips the .shell card entirely and
  // owns every pixel of the main column (sidebar + streaming conversation).
  const inFull = route.view === "home" || route.view === "notes";
  const meta = viewMeta(route);
  // Ctrl+K 命令面板 + 跨视图跳转的 pending 状态（由目标视图消费）。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pending, setPending] = useState<PendingJump | null>(null);

  // 双重入口避免冲突：
  // 1) Rust 全局快捷键 (CommandOrControl+K) 在窗口失焦/后台也能触发，经 `palette-open`
  //    事件通知前端（见 src-tauri/src/lib.rs）；前端此前从未监听该事件，导致 Ctrl+K 无响应。
  // 2) 窗口聚焦时保留本地 keydown，负责聚焦态下的打开 / 关闭切换。
  // 两者都可能命中同一次按键（Windows 全局 hook 是否吞键因平台而异），用时间戳护栏去重，
  // 保证一次按键只切换一次。
  const lastPaletteEvent = useRef(0);

  useEffect(() => {
    const unlisten = listen("palette-open", () => {
      lastPaletteEvent.current = Date.now();
      setPaletteOpen((value) => !value);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // 全局快捷键刚处理过同一次按键（150ms 内），本地 keydown 直接忽略，避免双开/双关。
        if (Date.now() - lastPaletteEvent.current < 150) return;
        setPaletteOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleJump(jump: PendingJump, hash: string): void {
    setPaletteOpen(false);
    // 纯导航类不需要 pending；会话 / 笔记类交给目标视图消费选中态。
    setPending(jump.kind === "view" ? null : jump);
    navigate(hash);
  }

  // 主题在首帧前由 index.html 内联脚本解析过；这里补挂系统档的
  // matchMedia 监听（跟随 OS 深浅切换实时生效）。
  useEffect(() => {
    initTheme();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getVersion().then(
      (value) => {
        if (!cancelled) setVersion({ status: "ok", value });
      },
      (err) => {
        if (cancelled) return;
        console.warn("[bootstrap] failed to load version", toErrorMessage(err));
        setVersion({ status: "error" });
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  if (inFull) {
    return (
      <div className="app-frame">
        <NavRail route={route} />
        <main className="main-col main-col--chat">
          <UpdateBanner info={updateState.update} onDismiss={updateState.dismiss} />
          {route.view === "notes" ? (
            <NotesView pending={pending} onPendingConsumed={() => setPending(null)} />
          ) : (
            <ChatView pending={pending} onPendingConsumed={() => setPending(null)} />
          )}
        </main>
        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onJump={handleJump} />}
      </div>
    );
  }

  return (
    <div className="app-frame">
      <NavRail route={route} />

      <main className="main-col">
        <div className="shell shell--full">
          <header className="header">
            <div className="header__badge" aria-hidden="true">
              MB
            </div>
            <div className="header__text">
              <h1 className="header__title">MindBase Desktop</h1>
              <p className="header__subtitle">{meta.subtitle}</p>
            </div>
            {version.status === "ok" && <span className="chip">v{version.value}</span>}
          </header>

          <UpdateBanner info={updateState.update} onDismiss={updateState.dismiss} />

          {inSettings ? (
            <>
              <nav className="tabs" role="tablist" aria-label="设置分类">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={route.tab === tab.id}
                    className={route.tab === tab.id ? "tab tab--active" : "tab"}
                    onClick={() => navigate(tab.hash)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
              <SystemSettings hidden={route.tab !== "system"} updateState={updateState} />
              <ApiSettings hidden={route.tab !== "api"} />
            </>
          ) : route.view === "knowledge" ? (
            <KnowledgeView />
          ) : route.view === "import" ? (
            <ImportView />
          ) : route.view === "quiz" ? (
            <QuizView />
          ) : route.view === "quiz-set" ? (
            <QuizSetView setId={route.setId} />
          ) : route.view === "resume" ? (
            <ResumeView />
          ) : route.view === "slides" ? (
            <SlidesView />
          ) : route.view === "skills" ? (
            <SkillsView />
          ) : (
            <FavoritesView />
          )}
        </div>
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onJump={handleJump} />}
    </div>
  );
}

export default App;
