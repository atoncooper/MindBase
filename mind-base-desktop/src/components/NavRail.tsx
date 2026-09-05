/**
 * 左侧导航栏：细图标栏，导航入口统一放左上。
 *
 * 纯 in-flow 布局（无 fixed/transform），点击切换 hash 路由，主区随路由
 * 渲染对应视图。活动项用反色图标块标记。
 */

import {
  FAVORITES_HASH,
  HOME_HASH,
  IMPORT_HASH,
  KNOWLEDGE_HASH,
  QUIZ_HASH,
  NOTES_HASH,
  RESUME_HASH,
  SETTINGS_API_HASH,
  SETTINGS_SYSTEM_HASH,
  SKILLS_HASH,
  SLIDES_HASH,
  navigate,
} from "../lib/router";
import type { Route } from "../lib/router";

/** Chat bubble glyph for the conversation workspace (home). */
function ChatIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-4.4 3.5A.7.7 0 0 1 4.5 20V17H6a2 2 0 0 1-2-2V6z" />
    </svg>
  );
}

/** Target glyph for the quiz view. */
function TargetIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" />
    </svg>
  );
}

/** Library glyph for the knowledge base view. */
function LibraryIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M5 4h4v16H5z" />
      <path d="M12 4h3l4 15.5" />
      <path d="M13.6 10.5h4.8" />
    </svg>
  );
}

/** Document glyph for the notes view. */
function NoteIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 3h9l5 5v13H6z" />
      <path d="M15 3v5h5" />
      <path d="M9 13h7" />
      <path d="M9 17h5" />
    </svg>
  );
}

/** Star glyph for favorites. */
function StarIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z" />
    </svg>
  );
}

/** Upload-onto-document glyph for the file-import view. */
function ImportIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 3h9l5 5v13H6z" />
      <path d="M15 3v5h5" />
      <path d="M12 10v7" />
      <path d="m9 13 3-3 3 3" />
    </svg>
  );
}

/** Gear glyph for system settings. */
function GearIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Plug glyph for the API/credentials tab. */
function PlugIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 3v5" />
      <path d="M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z" />
      <path d="M12 17v4" />
    </svg>
  );
}

/** Puzzle glyph for the skills manager view. */
function PuzzleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 1 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4z" />
    </svg>
  );
}

/** Document glyph for the resume generator view. */
function ResumeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  );
}

/** Presentation glyph for the slides agent view. */
function SlidesIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 4h18" />
      <rect x="4" y="4" width="16" height="11" rx="1" />
      <path d="M12 15v3" />
      <path d="M8 21l4-3 4 3" />
      <path d="M8 9l2.5 2L15 7.5" />
    </svg>
  );
}

interface RailItem {
  id: string;
  label: string;
  hash: string;
  icon: () => React.JSX.Element;
  active: (route: Route) => boolean;
}

/** Primary navigation, rendered top-down. */
const MAIN_RAIL_ITEMS: ReadonlyArray<RailItem> = [
  { id: "home", label: "对话", hash: HOME_HASH, icon: ChatIcon, active: (r) => r.view === "home" },
  { id: "quiz", label: "测验", hash: QUIZ_HASH, icon: TargetIcon, active: (r) => r.view === "quiz" || r.view === "quiz-set" },
  { id: "resume", label: "简历", hash: RESUME_HASH, icon: ResumeIcon, active: (r) => r.view === "resume" },
  { id: "slides", label: "PPT", hash: SLIDES_HASH, icon: SlidesIcon, active: (r) => r.view === "slides" },
  { id: "notes", label: "笔记", hash: NOTES_HASH, icon: NoteIcon, active: (r) => r.view === "notes" },
  { id: "knowledge", label: "知识库", hash: KNOWLEDGE_HASH, icon: LibraryIcon, active: (r) => r.view === "knowledge" },
  { id: "import", label: "文件入库", hash: IMPORT_HASH, icon: ImportIcon, active: (r) => r.view === "import" },
  { id: "favorites", label: "收藏夹", hash: FAVORITES_HASH, icon: StarIcon, active: (r) => r.view === "favorites" },
  { id: "skills", label: "技能", hash: SKILLS_HASH, icon: PuzzleIcon, active: (r) => r.view === "skills" },
];

/** Settings entries, pinned to the bottom of the rail. */
const SETTINGS_RAIL_ITEMS: ReadonlyArray<RailItem> = [
  { id: "system", label: "系统设置", hash: SETTINGS_SYSTEM_HASH, icon: GearIcon, active: (r) => r.view === "settings" && r.tab === "system" },
  { id: "api", label: "API 设置", hash: SETTINGS_API_HASH, icon: PlugIcon, active: (r) => r.view === "settings" && r.tab === "api" },
];

function NavRail({ route }: { route: Route }) {
  const renderItem = (item: RailItem): React.JSX.Element => {
    const active = item.active(route);
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        className={active ? "rail-btn rail-btn--active" : "rail-btn"}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        title={item.label}
        onClick={() => navigate(item.hash)}
      >
        <Icon />
      </button>
    );
  };
  return (
    <nav className="nav-rail" aria-label="主导航">
      {MAIN_RAIL_ITEMS.map(renderItem)}
      {/* 弹性占位：把设置组推到侧边栏最下方 */}
      <div className="nav-rail__spacer" aria-hidden="true" />
      {SETTINGS_RAIL_ITEMS.map(renderItem)}
    </nav>
  );
}

export default NavRail;
