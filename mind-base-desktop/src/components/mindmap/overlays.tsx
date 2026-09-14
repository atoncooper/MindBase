/**
 * 知识导图编辑器的浮层组件：右键菜单、节点样式面板、图标选择器、
 * 节点信息对话框与备注查看。
 *
 * 交互参考 ProcessOn（选中即出样式面板、右键菜单承载全部节点操作）；
 * 视觉遵循应用的单色 hairline 设计，配色收敛到纸墨基调 + 少量强调色。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { MindMapNodeInstance } from "simple-mind-map";
import type { MindMapNodeData, MindMapIconPack } from "../../lib/mindmap";
import { nodeIconList } from "simple-mind-map/src/svg/icons.js";
import type { MindMapIconGroup } from "simple-mind-map/src/svg/icons.js";
import { highlightCode, LANGUAGE_GROUPS } from "./codeBlock";

// ── 可选项（"" = 清除本节点的覆盖，回到主题默认） ──────────────────────

const FILL_COLORS = [
  "",
  "transparent",
  "#ffffff",
  "#f0f0ee",
  "#d3e3fd",
  "#e7f3ea",
  "#fdf3e0",
  "#fcebe9",
  "#1f1f1e",
];
const BORDER_COLORS = [
  "",
  "transparent",
  "#cbcbc7",
  "#8b8b86",
  "#1f1f1e",
  "#4a6fa5",
  "#2e8b74",
  "#b0673f",
  "#d93025",
];
const TEXT_COLORS = [
  "",
  "#1f1f1e",
  "#ffffff",
  "#6e6e6a",
  "#4a6fa5",
  "#2e8b74",
  "#b0673f",
  "#d93025",
];

const NODE_SHAPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "roundedRectangle", label: "圆角" },
  { value: "rectangle", label: "矩形" },
  { value: "ellipse", label: "椭圆" },
  { value: "circle", label: "圆形" },
  { value: "diamond", label: "菱形" },
  { value: "parallelogram", label: "平行" },
  { value: "octagonalRectangle", label: "八边" },
  { value: "outerTriangularRectangle", label: "外三角" },
  { value: "innerTriangularRectangle", label: "内三角" },
];

/** 连线颜色（选中节点 = 编辑它上方那条从父节点连入的线）。 */
const LINE_COLORS = [
  "",
  "#a8a8a3",
  "#4a6fa5",
  "#2e8b74",
  "#b0673f",
  "#d93025",
  "#1f1f1e",
  "#8b8b86",
];

/** 连线风格：curve 仅部分布局支持，不支持的组合由库自行回退。 */
const LINE_STYLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "curve", label: "曲线" },
  { value: "straight", label: "直线" },
  { value: "direct", label: "直连" },
];

/** 点击外部 / Esc 关闭；ref 指向浮层本体。 */
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

/** 把浮层夹回视口内（等首次渲染量到尺寸后校正一次）。 */
function clampPosition(x: number, y: number, el: HTMLElement): { left: number; top: number } {
  const rect = el.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
  };
}

// ── 右键菜单 ─────────────────────────────────────────────────────────

export interface ContextMenuItem {
  key: string;
  label?: string;
  disabled?: boolean;
  divider?: boolean;
  /** 分组小节标题（渲染为不可点的标题行，ProcessOn 式菜单分组）。 */
  header?: string;
  /** 右侧的快捷键提示，如 "Ctrl+C"。 */
  hint?: string;
  /** 点击后不关闭菜单（如图标选择）。 */
  keepOpen?: boolean;
  action?: () => void;
}

export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useOutsideClose(ref, onClose);

  useEffect(() => {
    const el = ref.current;
    if (el !== null) setPos(clampPosition(x, y, el));
  }, [x, y]);

  return (
    <div ref={ref} className="mm-ctx-menu" style={{ left: pos.left, top: pos.top }}>
      {items.map((item) =>
        item.divider ? (
          <div key={item.key} className="mm-ctx-divider" />
        ) : item.header !== undefined ? (
          <div key={item.key} className="mm-ctx-header">
            {item.header}
          </div>
        ) : (
          <button
            key={item.key}
            type="button"
            className="mm-ctx-item"
            disabled={item.disabled === true}
            onClick={() => {
              item.action?.();
              if (item.keepOpen !== true) onClose();
            }}
          >
            <span>{item.label}</span>
            {item.hint !== undefined && item.hint !== "" && (
              <span className="mm-ctx-hint">{item.hint}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

// ── 图标与标记选择器 ─────────────────────────────────────────────────

export function IconPicker({ x, y, activeIcons, onToggle, onClose }: {
  x: number;
  y: number;
  activeIcons: string[];
  onToggle: (iconKey: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useOutsideClose(ref, onClose);

  useEffect(() => {
    const el = ref.current;
    if (el !== null) setPos(clampPosition(x, y, el));
  }, [x, y]);

  return (
    <div ref={ref} className="mm-icon-panel" style={{ left: pos.left, top: pos.top }}>
      {nodeIconList.map((group) => (
        <div key={group.type}>
          <div className="mm-icon-group-title">{group.name}</div>
          <div className="mm-icon-grid">
            {group.list.map((item) => {
              const iconKey = `${group.type}_${item.name}`;
              const active = activeIcons.includes(iconKey);
              return (
                <button
                  key={iconKey}
                  type="button"
                  title={item.name}
                  className={active ? "mm-icon-btn mm-icon-btn--active" : "mm-icon-btn"}
                  onClick={() => onToggle(iconKey)}
                  dangerouslySetInnerHTML={{ __html: item.icon }}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 节点样式面板 ─────────────────────────────────────────────────────

function SwatchRow({ label, colors, value, onPick }: {
  label: string;
  colors: string[];
  value: string;
  onPick: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="mm-style-row">
      <span className="mm-style-label">{label}</span>
      {colors.map((color) => {
        const isEmpty = color === "";
        const isNone = color === "transparent";
        const className = [
          "mm-swatch",
          isEmpty ? "mm-swatch--empty" : "",
          isNone ? "mm-swatch--none" : "",
          value === color ? "mm-swatch--active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={isEmpty ? "empty" : color}
            type="button"
            title={isEmpty ? "跟随主题" : isNone ? "无色" : color}
            className={className}
            style={isEmpty || isNone ? undefined : { backgroundColor: color }}
            onClick={() => onPick(color)}
          />
        );
      })}
    </div>
  );
}

function MiniToggle({ active, label, onClick }: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={active ? "mm-style-mini mm-style-mini--active" : "mm-style-mini"}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function StylePanel({ node, onStyle, shifted }: {
  node: MindMapNodeInstance;
  onStyle: (prop: string, value: unknown) => void;
  /** 图形库侧边栏打开时右移避让。 */
  shifted?: boolean;
}): React.JSX.Element {
  const fill = node.getData<string>("fillColor") ?? "";
  const borderColor = node.getData<string>("borderColor") ?? "";
  const borderWidth = node.getData<number>("borderWidth");
  const color = node.getData<string>("color") ?? "";
  const fontSize = node.getData<number>("fontSize");
  const bold = (node.getData<string>("fontWeight") ?? "") === "bold";
  const italic = (node.getData<string>("fontStyle") ?? "") === "italic";
  const shape = node.getData<string>("shape") ?? "";
  const borderDasharray = node.getData<string>("borderDasharray") ?? "";
  const lineColor = node.getData<string>("lineColor") ?? "";
  const lineWidth = node.getData<number>("lineWidth");
  const lineDasharray = node.getData<string>("lineDasharray") ?? "";
  const lineStyle = node.getData<string>("lineStyle") ?? "";

  return (
    <div className={shifted ? "mm-style-panel mm-style-panel--shifted" : "mm-style-panel"}>
      <div className="mm-style-panel__title">节点样式 · 空色块=跟随主题</div>
      <div className="mm-style-row">
        <span className="mm-style-label">形状</span>
        {NODE_SHAPES.map((item) => (
          <MiniToggle
            key={item.value}
            label={item.label}
            active={shape === item.value}
            onClick={() => onStyle("shape", item.value)}
          />
        ))}
      </div>
      <SwatchRow label="填充" colors={FILL_COLORS} value={fill} onPick={(value) => onStyle("fillColor", value)} />
      <SwatchRow label="边框" colors={BORDER_COLORS} value={borderColor} onPick={(value) => onStyle("borderColor", value)} />
      <div className="mm-style-row">
        <span className="mm-style-label">宽度</span>
        {[0, 1, 2, 3].map((width) => (
          <MiniToggle
            key={width}
            label={String(width)}
            active={borderWidth === width}
            onClick={() => onStyle("borderWidth", width)}
          />
        ))}
        <MiniToggle
          label="虚线"
          active={borderDasharray !== "" && borderDasharray !== "none"}
          onClick={() =>
            onStyle("borderDasharray", borderDasharray !== "" && borderDasharray !== "none" ? "none" : "5,5")
          }
        />
      </div>
      <SwatchRow label="文字" colors={TEXT_COLORS} value={color} onPick={(value) => onStyle("color", value)} />
      <div className="mm-style-row">
        <span className="mm-style-label">字号</span>
        {[12, 14, 16, 18, 20, 24].map((size) => (
          <MiniToggle
            key={size}
            label={String(size)}
            active={fontSize === size}
            onClick={() => onStyle("fontSize", size)}
          />
        ))}
      </div>
      <div className="mm-style-row">
        <span className="mm-style-label">字形</span>
        <MiniToggle label="粗体" active={bold} onClick={() => onStyle("fontWeight", bold ? "normal" : "bold")} />
        <MiniToggle label="斜体" active={italic} onClick={() => onStyle("fontStyle", italic ? "normal" : "italic")} />
      </div>
      <div className="mm-style-panel__section">连线（该节点的上级连线）</div>
      <SwatchRow label="线色" colors={LINE_COLORS} value={lineColor} onPick={(value) => onStyle("lineColor", value)} />
      <div className="mm-style-row">
        <span className="mm-style-label">线宽</span>
        {[1, 2, 3, 4].map((width) => (
          <MiniToggle
            key={width}
            label={String(width)}
            active={lineWidth === width}
            onClick={() => onStyle("lineWidth", width)}
          />
        ))}
        <MiniToggle
          label="虚线"
          active={lineDasharray !== "" && lineDasharray !== "none"}
          onClick={() =>
            onStyle("lineDasharray", lineDasharray !== "" && lineDasharray !== "none" ? "none" : "5,5")
          }
        />
      </div>
      <div className="mm-style-row">
        <span className="mm-style-label">线形</span>
        {LINE_STYLES.map((item) => (
          <MiniToggle
            key={item.value}
            label={item.label}
            active={lineStyle === item.value}
            onClick={() => onStyle("lineStyle", item.value)}
          />
        ))}
      </div>
    </div>
  );
}

// ── 节点信息对话框（备注 / 链接 / 标签） ─────────────────────────────

export interface NodeInfoValues {
  note?: string;
  link?: string;
  linkTitle?: string;
  tagsText?: string;
}

const INFO_TITLES: Record<"note" | "link" | "tag", string> = {
  note: "节点备注",
  link: "节点链接",
  tag: "节点标签（逗号分隔多个）",
};

export function NodeInfoDialog({ kind, initial, onSave, onClose }: {
  kind: "note" | "link" | "tag";
  initial: NodeInfoValues;
  onSave: (values: NodeInfoValues) => void;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [note, setNote] = useState(initial.note ?? "");
  const [link, setLink] = useState(initial.link ?? "");
  const [linkTitle, setLinkTitle] = useState(initial.linkTitle ?? "");
  const [tagsText, setTagsText] = useState(initial.tagsText ?? "");
  useOutsideClose(boxRef, onClose);

  return (
    <div className="mm-overlay">
      <div className="mm-dialog" ref={boxRef}>
        <h3 className="mm-dialog__title">{INFO_TITLES[kind]}</h3>
        {kind === "note" && (
          <textarea
            value={note}
            placeholder="支持多行文本；留空保存即移除备注"
            onChange={(event) => setNote(event.target.value)}
            autoFocus
          />
        )}
        {kind === "link" && (
          <>
            <input
              type="text"
              className="cfg-input"
              placeholder="https://…（留空保存即移除链接）"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              autoFocus
            />
            <input
              type="text"
              className="cfg-input"
              placeholder="链接标题（可选）"
              value={linkTitle}
              onChange={(event) => setLinkTitle(event.target.value)}
            />
          </>
        )}
        {kind === "tag" && (
          <input
            type="text"
            className="cfg-input"
            placeholder="如：重要, 待办（留空保存即移除标签）"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
            autoFocus
          />
        )}
        <div className="mm-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => onSave({ note, link, linkTitle, tagsText })}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 备注查看（点节点上的备注图标弹出） ───────────────────────────────

export function NoteViewDialog({ text, onClose }: {
  text: string;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useOutsideClose(boxRef, onClose);

  return (
    <div className="mm-overlay">
      <div className="mm-dialog" ref={boxRef}>
        <h3 className="mm-dialog__title">节点备注</h3>
        <pre className="mm-note-view">{text === "" ? "（无备注内容）" : text}</pre>
        <div className="mm-dialog__actions">
          <button type="button" className="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LaTeX 公式（INSERT_FORMULA 追加到节点文本；清除 = 复位为纯文本） ──

export function FormulaDialog({ initialLatex = "", onSave, onClear, onClose }: {
  /** 编辑已有公式时的初始内容；空串表示新建。 */
  initialLatex?: string;
  onSave: (latex: string) => void;
  onClear: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [latex, setLatex] = useState(initialLatex);
  useOutsideClose(boxRef, onClose);
  const isEditing = initialLatex !== "";

  return (
    <div className="mm-overlay">
      <div className="mm-dialog" ref={boxRef}>
        <h3 className="mm-dialog__title">{isEditing ? "编辑 LaTeX 公式" : "插入 LaTeX 公式"}</h3>
        <HighlightedCodeEditor
          value={latex}
          onChange={setLatex}
          language="latex"
          onSubmit={() => {
            if (latex.trim() !== "") onSave(latex.trim());
          }}
          height={150}
          placeholder={"如：\\frac{a+b}{c} 或 x^2 + y^2 = z^2"}
        />
        <p className="hint-text">公式以 LaTeX 语法高亮输入、渲染进节点文本；「清除公式」把节点复位为纯文本。</p>
        <div className="mm-dialog__actions">
          <button type="button" className="button" onClick={onClear}>
            清除公式
          </button>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={latex.trim() === ""}
            onClick={() => onSave(latex.trim())}
          >
            {isEditing ? "保存公式" : "插入公式"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 代码块节点（以富文本 <pre> 作为独立子节点插入，等宽字体渲染） ──

/** 语言选择器：带搜索的分组下拉（26 种语言，全部带 Prism 高亮）。 */
function LangSelect({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useOutsideClose(ref, () => setOpen(false));
  const keyword = query.trim().toLowerCase();
  const groups = LANGUAGE_GROUPS.map((group) => ({
    name: group.name,
    items: group.items.filter((item) => item.label.toLowerCase().includes(keyword)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mm-lang-select" ref={ref}>
      <button type="button" className="mm-lang-trigger" onClick={() => setOpen((prev) => !prev)}>
        <span>{value === "" ? "无语言标注" : value}</span>
        <span className="mm-lang-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="mm-lang-pop">
          <input
            type="text"
            className="cfg-input mm-lang-search"
            placeholder="搜索语言…"
            value={query}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="mm-lang-list">
            <button
              type="button"
              className={value === "" ? "mm-lang-item mm-lang-item--active" : "mm-lang-item"}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              无语言标注
            </button>
            {groups.map((group) => (
              <div key={group.name}>
                <div className="mm-lang-group">{group.name}</div>
                {group.items.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={
                      value === item.value ? "mm-lang-item mm-lang-item--active" : "mm-lang-item"
                    }
                    onClick={() => {
                      onChange(item.value);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 高亮代码编辑区：行号栏 + Prism 高亮层 + 透明文本域（代码块/公式对话框共用）。 */
function HighlightedCodeEditor({ value, onChange, language, onSubmit, height, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  language: string;
  /** Ctrl/Cmd+Enter 触发；不传则 Ctrl+Enter 仅换行。 */
  onSubmit?: () => void;
  height: number;
  placeholder: string;
}): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const lineCount = Math.max(value.split("\n").length, 1);
  // 高亮层比代码区多渲染一个换行，保证末尾空行也能撑起高度。
  const highlighted = useMemo(() => `${highlightCode(value, language)}\n`, [value, language]);

  // 挂载即聚焦，不依赖 autoFocus 时序（双击节点打开对话框的场景）。
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // 输入法组合中的 Enter 是"选词确认"（keyCode 229 / key=Process），不处理。
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    // 挡掉 window 级监听（库快捷键等），编辑器内按键不外泄到画布。
    event.stopPropagation();
    const ta = event.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (onSubmit !== undefined && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (value.trim() !== "") onSubmit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const before = value.slice(0, start);
      const lineStart = before.lastIndexOf("\n") + 1;
      const indent = /^[ \t]*/.exec(before.slice(lineStart))?.[0] ?? "";
      const extra = /[{([]\s*$/.test(before.slice(lineStart)) ? "  " : "";
      const insert = `\n${indent}${extra}`;
      onChange(before + insert + value.slice(end));
      requestAnimationFrame(() => {
        if (taRef.current !== null) {
          taRef.current.selectionStart = taRef.current.selectionEnd = start + insert.length;
        }
      });
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (event.shiftKey) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const selected = value.slice(lineStart, end);
      const dedented = selected.replace(/^ {1,2}/gm, "");
      const removed = selected.length - dedented.length;
      onChange(value.slice(0, lineStart) + dedented + value.slice(end));
      requestAnimationFrame(() => {
        if (taRef.current !== null) {
          taRef.current.selectionStart = taRef.current.selectionEnd = Math.max(lineStart, start - removed);
        }
      });
    } else {
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        if (taRef.current !== null) {
          taRef.current.selectionStart = taRef.current.selectionEnd = start + 2;
        }
      });
    }
  }

  function syncScroll(): void {
    const ta = taRef.current;
    if (ta === null) return;
    if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop;
    if (highlightRef.current !== null) {
      highlightRef.current.scrollTop = ta.scrollTop;
      highlightRef.current.scrollLeft = ta.scrollLeft;
    }
  }

  return (
    <div className="mm-code-editor" style={{ height }}>
      <pre
        className="mm-code-gutter"
        ref={gutterRef}
        aria-hidden="true"
        onMouseDown={(event) => {
          event.preventDefault();
          taRef.current?.focus();
        }}
      >
        {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
      </pre>
      <div className="mm-code-body">
        <pre
          className="mm-code-highlight"
          ref={highlightRef}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
        <textarea
          className="mm-code-area"
          ref={taRef}
          value={value}
          wrap="off"
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}

export function CodeBlockDialog({ initialCode, initialLanguage, onSave, onDelete, onClose }: {
  /** 编辑已有代码块时的初始内容；空串表示新建节点。 */
  initialCode: string;
  initialLanguage: string;
  onSave: (code: string, language: string) => void;
  /** 编辑态传入后显示「删除代码块节点」（整节点删除）。 */
  onDelete?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [code, setCode] = useState(initialCode);
  const [language, setLanguage] = useState(initialLanguage);
  useOutsideClose(boxRef, onClose);
  const isEditing = initialCode !== "";
  const lineCount = Math.max(code.split("\n").length, 1);

  return (
    <div className="mm-overlay">
      <div className="mm-dialog mm-dialog--wide" ref={boxRef}>
        <div className="mm-dialog__title-row">
          <h3 className="mm-dialog__title">{isEditing ? "编辑代码块" : "插入代码块"}</h3>
          <LangSelect value={language} onChange={setLanguage} />
        </div>
        <HighlightedCodeEditor
          value={code}
          onChange={setCode}
          language={language}
          onSubmit={() => {
            if (code.trim() !== "") onSave(code, language);
          }}
          height={300}
          placeholder="粘贴或输入代码…（Tab 缩进，回车自动继承缩进，Ctrl+Enter 保存）"
        />
        <div className="mm-code-meta">
          <span className="hint-text">
            {isEditing ? "保存后替换该节点的代码内容" : "在选中节点下创建代码块子节点"}
          </span>
          <span className="hint-text">
            {lineCount} 行 · {code.length} 字符
          </span>
        </div>
        <div className="mm-dialog__actions">
          {isEditing && onDelete !== undefined && (
            <button type="button" className="button mm-btn-danger" onClick={onDelete}>
              删除代码块节点
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={code.trim() === ""}
            onClick={() => onSave(code, language)}
          >
            {isEditing ? "保存代码块" : "插入代码块"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 大纲面板（可编辑树：单击定位 / 双击重命名 / 悬停行操作） ──────────

export interface OutlineNodeItem {
  uid: string;
  text: string;
  expand: boolean;
  hasChildren: boolean;
  /** 附件角标：有备注 / 有链接 / 标签数 / 有图片。 */
  hasNote: boolean;
  hasLink: boolean;
  tagCount: number;
  hasImage: boolean;
  /** 根节点：不可删除 / 不可插同级 / 不可移动。 */
  isRoot: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  children: OutlineNodeItem[];
}

/** 把画布文档的根节点转成大纲树（uid 缺失的节点不可定位/重命名）。 */
export function toOutlineTree(root: MindMapNodeData): OutlineNodeItem {
  const toItems = (node: MindMapNodeData, isRoot: boolean): OutlineNodeItem => {
    const childNodes = node.children ?? [];
    const children = childNodes.map((child, index) => {
      const item = toItems(child, false);
      item.canMoveUp = index > 0;
      item.canMoveDown = index < childNodes.length - 1;
      return item;
    });
    return {
      uid: String(node.data.uid ?? ""),
      text: String(node.data.text ?? ""),
      expand: node.data.expand !== false,
      hasChildren: children.length > 0,
      hasNote: String(node.data.note ?? "") !== "",
      hasLink: String(node.data.hyperlink ?? "") !== "",
      tagCount: Array.isArray(node.data.tag) ? node.data.tag.length : 0,
      hasImage: Boolean(node.data.image),
      isRoot,
      canMoveUp: false,
      canMoveDown: false,
      children,
    };
  };
  return toItems(root, true);
}

export function OutlinePanel({ root, onLocate, onRename, onInsertChild, onInsertSibling, onRemove, onMoveUp, onMoveDown, onClose }: {
  root: OutlineNodeItem;
  onLocate: (uid: string) => void;
  onRename: (uid: string, text: string) => void;
  onInsertChild: (uid: string) => void;
  onInsertSibling: (uid: string) => void;
  onRemove: (uid: string) => void;
  onMoveUp: (uid: string) => void;
  onMoveDown: (uid: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(ref, onClose);
  // 大纲内的折叠是纯视图态，不影响画布节点的展开收起。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function toggleCollapse(uid: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) {
        next.delete(uid);
      } else {
        next.add(uid);
      }
      return next;
    });
  }

  function commitEdit(item: OutlineNodeItem): void {
    if (editingUid !== item.uid) return;
    setEditingUid(null);
    if (draft.trim() !== "" && draft.trim() !== item.text) {
      onRename(item.uid, draft.trim());
    }
  }

  function renderItems(items: OutlineNodeItem[], depth: number): React.JSX.Element[] {
    return items.map((item) => {
      const isCollapsed = collapsed.has(item.uid);
      const editing = editingUid === item.uid;
      return (
        <div key={item.uid === "" ? `no-uid-${depth}-${item.text}` : item.uid}>
          <div
            className="mm-outline-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onLocate(item.uid)}
            onDoubleClick={() => {
              setEditingUid(item.uid);
              setDraft(item.text);
            }}
          >
            {item.hasChildren ? (
              <button
                type="button"
                className="mm-outline-arrow"
                title={isCollapsed ? "展开" : "折叠"}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleCollapse(item.uid);
                }}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
            ) : (
              <span className="mm-outline-arrow mm-outline-arrow--leaf" />
            )}
            {editing ? (
              <input
                type="text"
                className="mm-outline-input"
                value={draft}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      // 挡住库的 window 级快捷键，避免改名按键打到画布。
                      event.stopPropagation();
                      if (event.key === "Enter") commitEdit(item);
                      if (event.key === "Escape") setEditingUid(null);
                    }}
                onBlur={() => commitEdit(item)}
              />
            ) : (
              <span className="mm-outline-text" title="单击定位 · 双击重命名">
                {item.text === "" ? "（空）" : item.text}
              </span>
            )}
            {(item.hasNote || item.hasLink || item.tagCount > 0 || item.hasImage) && (
              <span className="mm-outline-badges">
                {item.hasImage && <span className="mm-outline-badge" title="包含图片">图</span>}
                {item.hasNote && <span className="mm-outline-badge" title="有备注">注</span>}
                {item.hasLink && <span className="mm-outline-badge" title="有链接">链</span>}
                {item.tagCount > 0 && (
                  <span className="mm-outline-badge" title={`标签 × ${item.tagCount}`}>
                    #{item.tagCount}
                  </span>
                )}
              </span>
            )}
            <span className="mm-outline-actions" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                title="插入子节点"
                onClick={() => onInsertChild(item.uid)}
              >
                ＋
              </button>
              {!item.isRoot && (
                <button type="button" title="插入同级节点" onClick={() => onInsertSibling(item.uid)}>
                  ＋∥
                </button>
              )}
              {!item.isRoot && (
                <button
                  type="button"
                  title="上移"
                  disabled={!item.canMoveUp}
                  onClick={() => onMoveUp(item.uid)}
                >
                  ↑
                </button>
              )}
              {!item.isRoot && (
                <button
                  type="button"
                  title="下移"
                  disabled={!item.canMoveDown}
                  onClick={() => onMoveDown(item.uid)}
                >
                  ↓
                </button>
              )}
              {!item.isRoot && (
                <button
                  type="button"
                  title="删除节点及子级"
                  className="mm-outline-action--danger"
                  onClick={() => onRemove(item.uid)}
                >
                  ✕
                </button>
              )}
            </span>
          </div>
          {item.hasChildren && !isCollapsed && renderItems(item.children, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div ref={ref} className="mm-outline-panel">
      <div className="mm-outline-head">
        <span className="mm-style-panel__title">大纲 · 单击定位 / 双击重命名 / 悬停行操作</span>
        <button type="button" className="mm-btn" aria-label="收起大纲" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="mm-outline-body">{renderItems([root], 0)}</div>
    </div>
  );
}

// ── 图形库侧边栏（内置图标 + 用户导入的图形包） ───────────────────────

interface IconGridGroup {
  name: string;
  type: string;
  list: { name: string; icon: string }[];
}

/** 图标网格：svg 直接内联，图片（dataURL/URL）走 img 预览。 */
function IconGrid({ groups, activeIcons, onApply }: {
  groups: IconGridGroup[];
  activeIcons: string[];
  onApply: (iconKey: string) => void;
}): React.JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <section key={group.type}>
          <div className="mm-icon-group-title">{group.name}</div>
          <div className="mm-icon-grid">
            {group.list.map((item) => {
              const iconKey = `${group.type}_${item.name}`;
              const active = activeIcons.includes(iconKey);
              const isSvg = item.icon.startsWith("<svg");
              return (
                <button
                  key={iconKey}
                  type="button"
                  title={item.name}
                  className={active ? "mm-icon-btn mm-icon-btn--active" : "mm-icon-btn"}
                  onClick={() => onApply(iconKey)}
                >
                  {isSvg ? (
                    <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: item.icon }} />
                  ) : (
                    <img className="mm-icon-img" src={item.icon} alt={item.name} draggable={false} />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export function ShapesPanel({ packs, activeIcons, onApplyIcon, onDeletePack, onImportClick, importing, onClose }: {
  packs: MindMapIconPack[];
  activeIcons: string[];
  onApplyIcon: (iconKey: string) => void;
  onDeletePack: (key: string) => void;
  onImportClick: () => void;
  importing: boolean;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="mm-shapes-panel">
      <div className="mm-shapes-head">
        <span className="mm-style-panel__title">图形库 · 选中节点后点击应用</span>
        <span className="mm-shapes-head__actions">
          <button
            type="button"
            className="mm-btn"
            disabled={importing}
            onClick={onImportClick}
          >
            {importing ? "导入中…" : "导入图形包"}
          </button>
          <button type="button" className="mm-btn" aria-label="收起图形库" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="mm-shapes-body">
        <IconGrid groups={nodeIconList as MindMapIconGroup[]} activeIcons={activeIcons} onApply={onApplyIcon} />
        {packs.map((pack) => (
          <IconGrid
            key={pack.key}
            groups={[{ name: pack.name, type: pack.key, list: pack.items }]}
            activeIcons={activeIcons}
            onApply={onApplyIcon}
          />
        ))}
        {packs.length > 0 && (
          <div className="mm-shapes-pack-actions">
            {packs.map((pack) => (
              <button
                key={pack.key}
                type="button"
                className="mm-pack-delete"
                title={`删除图形包「${pack.name}」`}
                onClick={() => onDeletePack(pack.key)}
              >
                删除「{pack.name}」
              </button>
            ))}
          </div>
        )}
        <p className="hint-text">
          导入支持 SVG / PNG / JPG / WebP 图片或 JSON 清单（{'{"name":"…","items":[{"name":"…","icon":"<svg…|dataURL>"}]}'}），
          可从网上下载后导入，持久保存在本机数据目录。
        </p>
      </div>
    </div>
  );
}
