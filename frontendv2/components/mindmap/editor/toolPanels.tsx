/**
 * 导图编辑器的工具浮层：搜索替换、版本历史、快捷键帮助、小地图、
 * 模板选择（新建时）与通用命名对话框。交互沿用 overlays 的浮层约定
 * （点击外部 / Esc 关闭），样式走 App.css 的 mm-tool-* / mm-dialog 体系。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type MindMap from "simple-mind-map";
import type { MindMapSnapshotMeta, MindMapTemplate } from "@/lib/board-store";
import type { MindMapTemplateDef } from "./templates";

/** 点击浮层外部 / Esc 关闭（与 overlays.useOutsideClose 同一套约定）。 */
function useOutsideClose(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, onClose]);
}

// ── 搜索替换（Search 插件：search 相同文本 = 跳下一个） ───────────────

export function SearchPanel({ instance, onClose }: {
  instance: MindMap;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [match, setMatch] = useState<{ currentIndex: number; total: number }>({
    currentIndex: -1,
    total: 0,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  useOutsideClose(ref, () => {
    instance.search.endSearch();
    onClose();
  });

  useEffect(() => {
    inputRef.current?.focus();
    const onInfo = (info: unknown) => {
      const { currentIndex, total } = info as { currentIndex: number; total: number };
      setMatch({ currentIndex, total });
    };
    instance.on("search_info_change", onInfo);
    return () => {
      instance.off("search_info_change", onInfo);
    };
  }, [instance]);

  function runSearch(): void {
    const text = query.trim();
    if (text === "") return;
    instance.search.search(text);
  }

  function replaceOne(): void {
    if (replacement.trim() !== "") instance.search.replace(replacement);
  }

  function replaceAll(): void {
    if (replacement.trim() !== "") instance.search.replaceAll(replacement);
  }

  return (
    <div ref={ref} className="mm-tool-panel mm-search-panel">
      <div className="mm-search-row">
        <input
          ref={inputRef}
          type="text"
          className="cfg-input"
          placeholder="查找节点文本…（回车跳下一个）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") runSearch();
          }}
        />
        <span className="mm-search-count">
          {match.total > 0 ? `${match.currentIndex + 1} / ${match.total}` : "0 / 0"}
        </span>
      </div>
      <div className="mm-search-row">
        <input
          type="text"
          className="cfg-input"
          placeholder="替换为…（可留空）"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <button type="button" className="mm-btn" disabled={match.total === 0} onClick={replaceOne}>
          替换
        </button>
        <button type="button" className="mm-btn" disabled={match.total === 0} onClick={replaceAll}>
          全部替换
        </button>
      </div>
    </div>
  );
}

// ── 版本历史（快照列表 + 存一版 + 回滚） ─────────────────────────────

export function HistoryPanel({ snapshots, saving, onManualSnapshot, onRestore, onClose }: {
  snapshots: MindMapSnapshotMeta[] | null;
  saving: boolean;
  onManualSnapshot: () => void;
  onRestore: (snapshot: MindMapSnapshotMeta) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(ref, onClose);

  return (
    <div ref={ref} className="mm-tool-panel mm-history-panel">
      <div className="mm-outline-head">
        <span className="mm-style-panel__title">版本历史 · 保留最近 30 版</span>
        <button type="button" className="mm-btn" onClick={onClose} aria-label="关闭历史">
          ✕
        </button>
      </div>
      <div className="mm-history-actions">
        <button type="button" className="mm-btn" disabled={saving} onClick={onManualSnapshot}>
          {saving ? "保存中…" : "存一版"}
        </button>
        <span className="hint-text">回滚前当前内容会先自动备份</span>
      </div>
      <div className="mm-history-body">
        {snapshots === null && <p className="hint-text">加载中…</p>}
        {snapshots !== null && snapshots.length === 0 && (
          <p className="hint-text">还没有快照。点上面的「存一版」拍第一版。</p>
        )}
        {snapshots !== null &&
          snapshots.map((snapshot) => (
            <div key={snapshot.id} className="mm-history-row">
              <span className="mm-history-meta">
                <span className="mm-history-title">{snapshot.title}</span>
                <span>{new Date(snapshot.createdAt * 1000).toLocaleString()}</span>
              </span>
              <button
                type="button"
                className="mm-btn"
                onClick={() => onRestore(snapshot)}
              >
                回滚
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── 快捷键帮助面板 ───────────────────────────────────────────────────

const SHORTCUTS: ReadonlyArray<{ keys: string; desc: string }> = [
  { keys: "Tab", desc: "插入子节点" },
  { keys: "Enter", desc: "插入同级节点" },
  { keys: "Shift+Tab", desc: "插入父节点" },
  { keys: "Del / Backspace", desc: "删除节点及子级" },
  { keys: "Shift+Backspace", desc: "仅删除当前节点" },
  { keys: "Ctrl+Z / Ctrl+Y", desc: "撤销 / 重做" },
  { keys: "Ctrl+C / X / V", desc: "复制 / 剪切 / 粘贴" },
  { keys: "Ctrl+A", desc: "全选节点" },
  { keys: "Ctrl+G", desc: "添加概要" },
  { keys: "Ctrl+L", desc: "一键整理布局" },
  { keys: "/", desc: "展开 / 收起当前节点" },
  { keys: "双击节点", desc: "编辑文本（代码块节点打开代码对话框）" },
  { keys: "双击空白", desc: "在根节点下新建子节点" },
  { keys: "空白左键拖拽", desc: "平移画布；Ctrl/Meta + 拖拽框选" },
  { keys: "Ctrl+S", desc: "立即保存" },
];

export function ShortcutPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(ref, onClose);
  return (
    <div ref={ref} className="mm-tool-panel mm-shortcut-panel">
      <div className="mm-outline-head">
        <span className="mm-style-panel__title">快捷键</span>
        <button type="button" className="mm-btn" onClick={onClose} aria-label="关闭快捷键">
          ✕
        </button>
      </div>
      <div className="mm-shortcut-body">
        {SHORTCUTS.map((item) => (
          <div key={item.keys} className="mm-shortcut-row">
            <kbd>{item.keys}</kbd>
            <span>{item.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 小地图（MiniMap 插件：svgHTML + 视口框；点击小地图把该处居中） ────

export function MiniMapPanel({ instance, onClose }: {
  instance: MindMap;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // 最近一次计算的映射：小地图盒内坐标 → 场景坐标。
  const mappingRef = useRef<{
    sceneMinX: number;
    sceneMinY: number;
    scale: number;
    boxLeft: number;
    boxTop: number;
  } | null>(null);
  useOutsideClose(ref, onClose);

  const BOX_W = 260;
  const BOX_H = 160;

  const refresh = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (canvas === null || viewport === null) return;
    try {
      // 变换与包围盒先取（getSvgData 内部会临时改写再还原）。
      const transform = instance.view.getTransformData().transform;
      const rbox = instance.draw.rbox();
      const data = instance.getSvgData({ ignoreWatermark: true }) as {
        rect: { x: number; y: number; width: number; height: number; ratio: number };
      };
      const result = instance.miniMap.calculationMiniMap(BOX_W, BOX_H) as {
        svgHTML: string;
        viewBoxStyle: Record<string, string>;
        miniMapBoxScale: number;
        miniMapBoxLeft: number;
        miniMapBoxTop: number;
      };
      if (data.rect.width <= 0 || data.rect.height <= 0) return;
      canvas.innerHTML = result.svgHTML;
      const svg = canvas.querySelector("svg");
      if (svg !== null) {
        // 库克隆出的 svg 只有 width/height 属性（SVG.js size 不写 viewBox），
        // 直接 CSS 缩小会变成"裁剪"而非"缩放"——必须补 viewBox。
        const actWidth = result.miniMapBoxScale * data.rect.width;
        const actHeight = actWidth / data.rect.ratio;
        svg.setAttribute("viewBox", `0 0 ${data.rect.width} ${data.rect.height}`);
        svg.style.width = `${actWidth}px`;
        svg.style.height = `${actHeight}px`;
        svg.style.position = "absolute";
        svg.style.left = `${result.miniMapBoxLeft}px`;
        svg.style.top = `${result.miniMapBoxTop}px`;
        svg.style.pointerEvents = "none";
      }
      Object.entries(result.viewBoxStyle).forEach(([key, value]) => {
        viewport.style[key as "left"] = value;
      });
      // 内容包围盒的场景原点：screen = scene * scale + translate。
      mappingRef.current = {
        sceneMinX: (rbox.x - transform.translateX) / transform.scaleX,
        sceneMinY: (rbox.y - transform.translateY) / transform.scaleY,
        scale: result.miniMapBoxScale,
        boxLeft: result.miniMapBoxLeft,
        boxTop: result.miniMapBoxTop,
      };
    } catch (err) {
      console.warn("[mindmap] minimap refresh failed:", err);
    }
  }, [instance]);

  useEffect(() => {
    refresh();
    const rafRef = { current: 0 };
    // 平移/缩放期间 view_data_change 连续触发，rAF 合帧限制重算频率。
    const onViewChange = (): void => {
      if (rafRef.current !== 0) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        refresh();
      });
    };
    instance.on("view_data_change", onViewChange);
    instance.on("node_tree_render_end", onViewChange);
    return () => {
      if (rafRef.current !== 0) window.cancelAnimationFrame(rafRef.current);
      instance.off("view_data_change", onViewChange);
      instance.off("node_tree_render_end", onViewChange);
    };
  }, [instance, refresh]);

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>): void {
    const mapping = mappingRef.current;
    if (mapping === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left - mapping.boxLeft;
    const py = event.clientY - box.top - mapping.boxTop;
    // 小地图盒内坐标 → 场景坐标（盒左上角 = 内容包围盒的场景最小角）。
    const sceneX = mapping.sceneMinX + px / mapping.scale;
    const sceneY = mapping.sceneMinY + py / mapping.scale;
    // 视口变换：screen = scene * scale + translate；把点中的场景位置居中。
    const transform = instance.view.getTransformData().transform;
    const targetTx = instance.el.clientWidth / 2 - sceneX * transform.scaleX;
    const targetTy = instance.el.clientHeight / 2 - sceneY * transform.scaleY;
    instance.view.translateXY(
      targetTx - transform.translateX,
      targetTy - transform.translateY,
    );
  }

  return (
    <div ref={ref} className="mm-tool-panel mm-minimap-panel">
      <div className="mm-outline-head">
        <span className="mm-style-panel__title">小地图 · 点击定位</span>
        <button type="button" className="mm-btn" onClick={onClose} aria-label="关闭小地图">
          ✕
        </button>
      </div>
      <div className="mm-minimap-stage" style={{ width: BOX_W, height: BOX_H }}>
        <div
          ref={canvasRef}
          className="mm-minimap-canvas"
          onClick={handleMapClick}
        />
        <div ref={viewportRef} className="mm-minimap-viewport" aria-hidden="true" />
      </div>
    </div>
  );
}

// ── 通用命名对话框（存为模板等单输入场景） ────────────────────────────

export function PromptDialog({ title, placeholder, initial, confirmText, onSubmit, onClose }: {
  title: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(initial ?? "");
  useOutsideClose(boxRef, onClose);
  return (
    <div className="mm-overlay">
      <div className="mm-dialog" ref={boxRef}>
        <h3 className="mm-dialog__title">{title}</h3>
        <input
          type="text"
          className="cfg-input"
          placeholder={placeholder}
          value={value}
          autoFocus
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && value.trim() !== "") onSubmit(value.trim());
          }}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="mm-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={value.trim() === ""}
            onClick={() => onSubmit(value.trim())}
          >
            {confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 模板选择对话框（新建导图时） ─────────────────────────────────────

export function TemplateDialog({ builtin, userTemplates, onPick, onDeleteUser, onClose }: {
  builtin: ReadonlyArray<MindMapTemplateDef>;
  userTemplates: MindMapTemplate[];
  onPick: (template: { name: string; data: string } | null) => void;
  onDeleteUser: (key: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useOutsideClose(boxRef, onClose);
  return (
    <div className="mm-overlay">
      <div className="mm-dialog mm-dialog--wide" ref={boxRef}>
        <h3 className="mm-dialog__title">选择模板</h3>
        <div className="mm-template-grid">
          {builtin.map((template) => (
            <button
              key={template.name}
              type="button"
              className="mm-template-card"
              onClick={() => onPick({ name: template.name, data: JSON.stringify(template.doc) })}
            >
              <span className="mm-template-name">{template.name}</span>
              <span className="mm-template-hint">{template.hint}</span>
            </button>
          ))}
        </div>
        {userTemplates.length > 0 && (
          <>
            <h3 className="mm-dialog__title" style={{ marginTop: 14 }}>
              我的模板
            </h3>
            <div className="mm-template-grid">
              {userTemplates.map((template) => (
                <div key={template.key} className="mm-template-card mm-template-card--user">
                  <button
                    type="button"
                    className="mm-template-main"
                    onClick={() => onPick({ name: template.name, data: template.data })}
                  >
                    <span className="mm-template-name">{template.name}</span>
                    <span className="mm-template-hint">用户模板</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除模板 ${template.name}`}
                    title="删除模板"
                    onClick={() => onDeleteUser(template.key)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="mm-dialog__actions">
          <span className="hint-text">在导图编辑器里可以「存为模板」把当前结构沉淀下来</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
