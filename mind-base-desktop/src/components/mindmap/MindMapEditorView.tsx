/**
 * 知识导图编辑器（全幅）：顶部工具栏 + simple-mind-map 画布。
 *
 * 键盘快捷键由库内置（Enter 同级 / Tab 子级 / Del 删除 / Ctrl+Z·Y 撤销重做
 * / 双击改文本），工具栏是同一批命令的鼠标入口。保存策略：树变更防抖
 * 800ms 自动保存 + Ctrl+S 手动 + 卸载/切图前兜底 flush，标题与整卡文档
 * 一起覆盖写回 SQLite。画布主题跟随应用深浅档实时重配色。
 */

import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type MindMap from "simple-mind-map";
import type { MindMapNodeInstance } from "simple-mind-map";
import { nodeIconList } from "simple-mind-map/src/svg/icons.js";
import { MINDMAP_HASH, mindMapHash, navigate } from "../../lib/router";
import {
  createMindMap,
  createMindMapSnapshot,
  deleteMindMapIconPack,
  getMindMap,
  listMindMapIconPacks,
  listMindMapSnapshots,
  restoreMindMapSnapshot,
  saveMindMap,
  saveMindMapExport,
  saveMindMapIconPack,
  saveMindMapTemplate,
} from "../../lib/mindmap";
import type { MindMapDoc, MindMapIconPack, MindMapIconPackItem, MindMapSnapshotMeta } from "../../lib/mindmap";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";
import MindMapCanvas from "./MindMapCanvas";
import WhiteboardEditorView from "../whiteboard/WhiteboardEditorView";
import {
  CodeBlockDialog,
  ContextMenu,
  FormulaDialog,
  IconPicker,
  NodeInfoDialog,
  NoteViewDialog,
  OutlinePanel,
  ShapesPanel,
  StylePanel,
  toOutlineTree,
} from "./overlays";
import type { ContextMenuItem, NodeInfoValues } from "./overlays";
import { buildInteractiveHtml } from "./exportHtml";
import { buildCodeBlockHtml, extractCodeBlock } from "./codeBlock";
import { LAYOUTS, LINE_PRESETS, buildThemeConfig, isAppDark, parseMindMapDoc } from "./doc";
import { convertDocToWhiteboardScene } from "../whiteboard/convert";
import {
  HistoryPanel,
  MiniMapPanel,
  PromptDialog,
  SearchPanel,
  ShortcutPanel,
} from "./toolPanels";

const ACCENT_KEY = "mb-mm-accent";
const RAINBOW_KEY = "mb-mm-rainbow";
const AUTOSAVE_DELAY_MS = 800;
/** 自动快照最小间隔：距上一版 ≥10 分钟且本次有落库才拍。 */
const AUTO_SNAPSHOT_INTERVAL_SEC = 600;

function loadAccent(): string {
  try {
    return window.localStorage.getItem(ACCENT_KEY) ?? "ink";
  } catch {
    return "ink";
  }
}

function loadRainbow(): boolean {
  try {
    return window.localStorage.getItem(RAINBOW_KEY) === "1";
  } catch {
    return false;
  }
}

type SaveState = "saved" | "pending" | "saving";

function MindMapEditorView({ mapId }: { mapId: string }): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "whiteboard">("loading");
  const [doc, setDoc] = useState<MindMapDoc | null>(null);
  const [title, setTitle] = useState("");
  const [accentId, setAccentId] = useState(loadAccent);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [exporting, setExporting] = useState<string | null>(null);
  // 右键菜单（节点）/ 画布菜单 / 节点信息对话框 / 备注查看。
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    node: MindMapNodeInstance;
    iconsOpen: boolean;
  } | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);
  const [infoDialog, setInfoDialog] = useState<{
    kind: "note" | "link" | "tag";
    initial: NodeInfoValues;
    /** 打开对话框时右键命中的节点（保存动作的显式目标，不依赖选中集）。 */
    node: MindMapNodeInstance;
  } | null>(null);
  const [noteView, setNoteView] = useState<string | null>(null);
  const [formulaDialogOpen, setFormulaDialogOpen] = useState(false);
  /** 代码块对话框上下文：null = 关闭；否则为新建/编辑目标与初始内容。 */
  const [codeBlockEdit, setCodeBlockEdit] = useState<{
    node: MindMapNodeInstance;
    code: string;
    language: string;
    isNew: boolean;
  } | null>(null);
  /** 大纲面板开合；彩虹连线为应用级偏好（localStorage 记忆）。 */
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [rainbowOpen, setRainbowOpen] = useState(loadRainbow);
  /** 图形库侧边栏与用户图形包（存 <数据目录>/mindmap-icons/）。 */
  const [shapesOpen, setShapesOpen] = useState(false);
  const [iconPacks, setIconPacks] = useState<MindMapIconPack[]>([]);
  const [importingPack, setImportingPack] = useState(false);
  /** ── 工具面板：搜索 / 小地图 / 版本历史 / 快捷键 / 存为模板 ── */
  const [searchOpen, setSearchOpen] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [templatePromptOpen, setTemplatePromptOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<MindMapSnapshotMeta[] | null>(null);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [converting, setConverting] = useState(false);
  /** 回滚后递增：强制重载文档并重挂载画布。 */
  const [reloadToken, setReloadToken] = useState(0);
  const toast = useToast();

  const instanceRef = useRef<MindMap | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const trailingRef = useRef(false);
  // flush 在卸载后仍要读到最新标题 / 最新文档：一律经 ref 而不是闭包。
  const titleRef = useRef("");
  const accentRef = useRef(accentId);
  accentRef.current = accentId;
  const docRef = useRef<MindMapDoc | null>(null);
  docRef.current = doc;
  /** 最近一份完整文档（树/布局/主题/视图），卸载后兜底 flush 用。 */
  const latestDocRef = useRef<MindMapDoc | null>(null);
  const doFlushRef = useRef<() => Promise<void>>(async () => {});
  /** 当前选中节点（右键菜单 / 样式面板 / 节点信息的操作目标）。 */
  const activeNodesRef = useRef<MindMapNodeInstance[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** 右键菜单动作的显式目标：图片/公式作用于右键命中的节点，不依赖选中集。 */
  const imageTargetRef = useRef<MindMapNodeInstance | null>(null);
  const formulaTargetRef = useRef<MindMapNodeInstance | null>(null);
  /** 格式刷：复制样式 → 粘贴样式的剪贴板（白名单键，见 ALLOWED_STYLE_KEYS）。 */
  const styleClipboardRef = useRef<Record<string, unknown> | null>(null);
  const iconPacksRef = useRef<MindMapIconPack[]>([]);
  iconPacksRef.current = iconPacks;
  const importInputRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次快照时间（秒）；自动快照按此判断间隔。 */
  const lastSnapshotAtRef = useRef(0);

  function scheduleSave(): void {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setSaveState("pending");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void doFlushRef.current();
    }, AUTOSAVE_DELAY_MS);
  }

  function markDirtyAndSchedule(): void {
    dirtyRef.current = true;
    scheduleSave();
  }

  async function doFlush(): Promise<void> {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    if (inFlightRef.current) {
      // 上一笔还没落库：落库后补一笔，保证最后一次变更不丢。
      trailingRef.current = true;
      return;
    }
    const snapshot = latestDocRef.current;
    if (snapshot === null) return;
    inFlightRef.current = true;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      await saveMindMap(mapId, titleRef.current, snapshot);
      // 落库成功 → 距上一版超过间隔就顺手拍一版自动快照（失败静默）。
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - lastSnapshotAtRef.current >= AUTO_SNAPSHOT_INTERVAL_SEC) {
        lastSnapshotAtRef.current = nowSec;
        void createMindMapSnapshot(mapId).catch(() => undefined);
      }
      setSaveState("saved");
    } catch (err) {
      dirtyRef.current = true;
      setSaveState("pending");
      toast.error(toErrorMessage(err), { title: "自动保存失败" });
    } finally {
      inFlightRef.current = false;
      if (trailingRef.current) {
        trailingRef.current = false;
        scheduleSave();
      }
    }
  }
  doFlushRef.current = doFlush;

  // 加载导图；卸载 / 换图前兜底 flush（此刻画布可能已销毁，
  // flush 走 latestDocRef，不再依赖实例）。kind = whiteboard 的对象由
  // WhiteboardEditorView 接管（早退分发），不进入下面的导图初始化。
  useEffect(() => {
    let cancelled = false;
    void getMindMap(mapId).then(
      (detail) => {
        if (cancelled) return;
        if (detail === null) {
          setPhase("missing");
          return;
        }
        if (detail.kind === "whiteboard") {
          setPhase("whiteboard");
          return;
        }
        const parsed = parseMindMapDoc(detail.data, accentRef.current, isAppDark());
        setTitle(detail.title);
        titleRef.current = detail.title;
        latestDocRef.current = parsed;
        dirtyRef.current = false;
        setDoc(parsed);
        setPhase("ready");
        // 初始化自动快照的间隔基准（最新一版的时间）。
        void listMindMapSnapshots(mapId)
          .then((rows) => {
            lastSnapshotAtRef.current = rows[0]?.createdAt ?? 0;
          })
          .catch(() => undefined);
      },
      () => {
        if (!cancelled) setPhase("missing");
      },
    );
    return () => {
      cancelled = true;
      void doFlushRef.current();
    };
  }, [mapId, reloadToken]);

  // 对话框打开期间暂停库的全局快捷键（库把 Enter/Tab/Del/Ctrl+Z 绑在
  // window 上，会抢走对话框输入框里的按键——"编辑代码块回车无效"即 Enter
  // 被库当成了插入同级节点）。关闭对话框后恢复。
  // 注意：恢复方法是 recovery()；restore() 是 save/restore 缓存交换对，
  // 不会复位 isPause，误用会导致画布快捷键永久失效。
  const dialogBlocking =
    codeBlockEdit !== null || formulaDialogOpen || infoDialog !== null || noteView !== null;
  useEffect(() => {
    const instance = instanceRef.current;
    if (instance === null) return;
    if (dialogBlocking) {
      instance.keyCommand.pause();
    } else {
      instance.keyCommand.recovery();
    }
  }, [dialogBlocking]);

  // Ctrl+S 手动保存（画布内快捷键归库管，这里是全局兜底）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void doFlushRef.current();
      }
      // Ctrl+F 呼出搜索面板（库未占用该组合键）。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 应用主题切档（系统浅深切换 / 设置页切换）→ 画布实时重配色。
  const applyThemeRef = useRef<() => void>(() => {});
  applyThemeRef.current = () => {
    const prev = docRef.current;
    if (prev === null) return;
    const config = buildThemeConfig(accentRef.current, isAppDark());
    instanceRef.current?.setThemeConfig(config);
    const next: MindMapDoc = { ...prev, theme: { config } };
    setDoc(next);
    latestDocRef.current = next;
    markDirtyAndSchedule();
  };
  useEffect(() => {
    if (phase !== "ready") return;
    let lastDark = isAppDark();
    const observer = new MutationObserver(() => {
      const nowDark = isAppDark();
      if (nowDark === lastDark) return;
      lastDark = nowDark;
      applyThemeRef.current();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [phase]);

  function exec(command: string, ...args: unknown[]): void {
    instanceRef.current?.execCommand(command, ...args);
  }

  /** 对全部选中节点应用一次操作（右键目标节点已被库置为激活）。 */
  function applyToActive(apply: (node: MindMapNodeInstance) => void): void {
    for (const node of activeNodesRef.current) apply(node);
  }

  function applyStyle(prop: string, value: unknown): void {
    applyToActive((node) => exec("SET_NODE_STYLE", node, prop, value));
    // lineStyle 不在库的 lineStyleProps 清单里，写完后需整树重渲染才会
    // 重画连线；其余连线属性（颜色/宽度/虚线）库会自动 renderLine。
    if (prop === "lineStyle") instanceRef.current?.render();
  }

  function toggleIcon(iconKey: string, targetNodes?: MindMapNodeInstance[]): void {
    const list = targetNodes ?? activeNodesRef.current;
    for (const node of list) {
      const current = node.getData<string[]>("icon") ?? [];
      const next = current.includes(iconKey)
        ? current.filter((key) => key !== iconKey)
        : [...current, iconKey];
      exec("SET_NODE_ICON", node, next);
    }
  }

  function openInfo(kind: "note" | "link" | "tag"): void {
    const node = ctxMenu?.node ?? null;
    if (node === null) return;
    setInfoDialog({
      kind,
      node,
      initial: {
        note: String(node.getData("note") ?? ""),
        link: String(node.getData("hyperlink") ?? ""),
        linkTitle: String(node.getData("hyperlinkTitle") ?? ""),
        tagsText: (node.getData<string[]>("tag") ?? []).join(", "),
      },
    });
  }

  function saveInfo(values: NodeInfoValues): void {
    const kind = infoDialog?.kind;
    const target = infoDialog?.node ?? null;
    setInfoDialog(null);
    if (target === null || kind === undefined) return;
    if (kind === "note") {
      const text = (values.note ?? "").trim();
      exec("SET_NODE_NOTE", target, text === "" ? null : text);
    } else if (kind === "link") {
      const url = (values.link ?? "").trim();
      const linkTitle = (values.linkTitle ?? "").trim();
      exec("SET_NODE_HYPERLINK", target, url === "" ? null : url, linkTitle);
    } else {
      const tags = (values.tagsText ?? "")
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      exec("SET_NODE_TAG", target, tags.length > 0 ? tags : null);
    }
  }

  async function handleImageFile(file: File): Promise<void> {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error("解析图片尺寸失败"));
        img.src = dataUrl;
      });
      // 目标 = 右键命中节点（菜单打开时已捕获）；兜底用当前选中集。
      const targetsList =
        imageTargetRef.current !== null ? [imageTargetRef.current] : activeNodesRef.current;
      for (const node of targetsList) {
        exec("SET_NODE_IMAGE", node, {
          url: dataUrl,
          title: file.name,
          width: dims.width,
          height: dims.height,
        });
      }
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "插入图片失败" });
    }
  }

  /**
   * 把当前激活的关联线改连到指定节点：关联线存储在起始节点的
   * associativeLineTargets（目标 uid 列表）上，替换对应项并清空该线的
   * 锚点/控制点偏移即可完成重连。
   */
  function retargetActiveLine(newNode: MindMapNodeInstance): void {
    const instance = instanceRef.current;
    if (instance === null) return;
    const activeLine = instance.associativeLine.activeLine;
    if (activeLine === undefined || activeLine === null) return;
    const fromNode = activeLine[3] as MindMapNodeInstance | undefined;
    const toNode = activeLine[4] as MindMapNodeInstance | undefined;
    if (fromNode === undefined || toNode === undefined) return;
    const uidOf = (item: MindMapNodeInstance): string => String(item.getData("uid") ?? "");
    const newUid = uidOf(newNode);
    const toUid = uidOf(toNode);
    if (newUid === "" || newUid === uidOf(fromNode) || newUid === toUid) return;
    const targets = [...(fromNode.getData<string[]>("associativeLineTargets") ?? [])];
    const index = targets.indexOf(toUid);
    if (index === -1) return;
    targets[index] = newUid;
    const points = [...(fromNode.getData<unknown[]>("associativeLinePoint") ?? [])];
    if (index < points.length) points[index] = null;
    const offsets = [
      ...(fromNode.getData<unknown[]>("associativeLineTargetControlOffsets") ?? []),
    ];
    if (index < offsets.length) offsets[index] = null;
    fromNode.setData({
      associativeLineTargets: targets,
      associativeLinePoint: points,
      associativeLineTargetControlOffsets: offsets,
    });
    instance.render();
  }

  /** 格式刷可复制/粘贴的样式键白名单（防止把目标数据/分支方向/尺寸等一并带过去）。 */
  const ALLOWED_STYLE_KEYS = [
    "fillColor",
    "color",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "borderColor",
    "borderWidth",
    "borderDasharray",
    "shape",
    "paddingX",
    "paddingY",
    "lineColor",
    "lineWidth",
    "lineDasharray",
    "lineStyle",
  ];

  function copyNodeStyle(): void {
    const node = ctxMenu?.node ?? null;
    if (node === null) return;
    const data = node.getData<Record<string, unknown>>();
    const styles: Record<string, unknown> = {};
    for (const key of ALLOWED_STYLE_KEYS) {
      if (data[key] !== undefined) styles[key] = data[key];
    }
    styleClipboardRef.current = styles;
  }

  function pasteNodeStyle(): void {
    const styles = styleClipboardRef.current;
    const node = ctxMenu?.node ?? null;
    if (styles === null || node === null) return;
    exec("SET_NODE_STYLES", node, { ...styles });
    // lineStyle 不在库的 lineStyleProps 清单里，粘贴后整树重渲染确保连线重画。
    instanceRef.current?.render();
  }

  function buildNodeMenuItems(): ContextMenuItem[] {
    const node = ctxMenu?.node ?? null;
    // 所有节点级动作显式以右键命中的节点为目标——不依赖当时的选中集，
    // 消除"右键激活时序差导致点击菜单项无效"的竞态。
    const targets = node !== null ? [node] : [];
    const isRoot = node?.isRoot === true;
    // 当前有激活（已单击选中）的关联线时：右键其他节点可将其改连/删除
    const activeLine = instanceRef.current?.associativeLine.activeLine ?? null;
    const lineItems: ContextMenuItem[] = [];
    if (activeLine !== null && node !== null) {
      const fromNode = activeLine[3] as MindMapNodeInstance | undefined;
      const toNode = activeLine[4] as MindMapNodeInstance | undefined;
      if (fromNode !== undefined && toNode !== undefined) {
        const uidOf = (item: MindMapNodeInstance): string => String(item.getData("uid") ?? "");
        const nodeUid = uidOf(node);
        const isConnectedEndpoint = nodeUid === uidOf(fromNode) || nodeUid === uidOf(toNode);
        if (!isConnectedEndpoint) {
          lineItems.push({
            key: "retarget-line",
            label: "将选中的关联线改连到此节点",
            action: () => retargetActiveLine(node),
          });
        }
        lineItems.push({
          key: "remove-line",
          label: "删除选中的关联线",
          action: () => instanceRef.current?.associativeLine.removeLine(),
        });
      }
    }
    const hasImage = node !== null && Boolean(node.getData("image"));
    const expanded = node !== null && node.getData("expand") !== false;
    return [
      { key: "h-insert", header: "插入" },
      { key: "child", label: "插入子节点", hint: "Tab", action: () => exec("INSERT_CHILD_NODE", true, targets) },
      {
        key: "sibling",
        label: "插入同级节点",
        hint: "Enter",
        disabled: isRoot,
        action: () => exec("INSERT_NODE", true, targets),
      },
      {
        key: "parent",
        label: "插入父节点",
        disabled: isRoot,
        action: () => exec("INSERT_PARENT_NODE", true, targets),
      },
      { key: "h-edit", header: "编辑" },
      { key: "up", label: "上移节点", disabled: isRoot, action: () => exec("UP_NODE", node) },
      { key: "down", label: "下移节点", disabled: isRoot, action: () => exec("DOWN_NODE", node) },
      ...(
        doc?.layout === "mindMap" && !isRoot && node?.parent?.isRoot === true
          ? [
              { key: "dir-left", label: "分支放到左侧", action: () => setNodeDir("left") },
              { key: "dir-right", label: "分支放到右侧", action: () => setNodeDir("right") },
              { key: "dir-reset", label: "恢复默认方向", action: () => setNodeDir(undefined) },
            ]
          : []
      ),
      {
        key: "move-up-level",
        label: "提升一级",
        disabled: isRoot || (node?.layerIndex ?? 0) <= 1,
        action: () => exec("MOVE_UP_ONE_LEVEL", node),
      },
      { key: "h-clip", header: "剪贴板" },
      { key: "copy", label: "复制", hint: "Ctrl+C", action: () => instanceRef.current?.renderer.copy() },
      { key: "cut", label: "剪切", hint: "Ctrl+X", action: () => instanceRef.current?.renderer.cut() },
      { key: "paste", label: "粘贴", hint: "Ctrl+V", action: () => instanceRef.current?.renderer.paste() },
      {
        key: "copy-style",
        label: "复制样式",
        disabled: node === null,
        action: () => copyNodeStyle(),
      },
      {
        key: "paste-style",
        label: "粘贴样式",
        disabled: styleClipboardRef.current === null || node === null,
        action: () => pasteNodeStyle(),
      },
      { key: "h-delete", header: "删除" },
      { key: "remove", label: "删除节点及子级", hint: "Del", action: () => exec("REMOVE_NODE", targets) },
      {
        key: "remove-current",
        label: "仅删除当前节点（子级上移）",
        action: () => exec("REMOVE_CURRENT_NODE", targets),
      },
      { key: "h-content", header: "节点内容" },
      {
        key: "image",
        label: hasImage ? "更换图片…" : "插入图片…",
        action: () => {
          imageTargetRef.current = node;
          imageInputRef.current?.click();
        },
      },
      ...(hasImage
        ? [
            {
              key: "image-remove",
              label: "移除图片",
              action: () => {
                if (node !== null) exec("SET_NODE_IMAGE", node, null);
              },
            },
          ]
        : []),
      {
        key: "icon",
        label: "图标与标记",
        keepOpen: true,
        action: () => setCtxMenu((prev) => (prev ? { ...prev, iconsOpen: !prev.iconsOpen } : prev)),
      },
      { key: "tag", label: "标签…", action: () => openInfo("tag") },
      { key: "link", label: "链接…", action: () => openInfo("link") },
      { key: "note", label: "备注…", action: () => openInfo("note") },
      {
        key: "formula",
        label: "公式…",
        action: () => {
          formulaTargetRef.current = node;
          setFormulaDialogOpen(true);
        },
      },
      ...(node !== null
        ? [
            {
              key: "code",
              label: "添加代码块节点…",
              action: () => setCodeBlockEdit({ node, code: "", language: "", isNew: true }),
            },
          ]
        : []),
      {
        key: "gen",
        label: "添加概要",
        disabled: isRoot,
        action: () => {
          // 概要命令内部取选中集：先把右键节点置为激活再执行。
          if (node !== null) node.active();
          exec("ADD_GENERALIZATION", { text: "概要" });
        },
      },
      {
        key: "frame",
        label: "添加外框",
        action: () =>
          exec("ADD_OUTER_FRAME", targets.length > 0 ? targets : activeNodesRef.current, {}),
      },
      {
        key: "assoc",
        label: "添加关联线",
        action: () => {
          if (node !== null) node.active();
          instanceRef.current?.associativeLine.createLineFromActiveNode();
        },
      },
      ...(lineItems.length > 0 ? [{ key: "h-line", header: "关联线" }, ...lineItems] : []),
      { key: "h-layout", header: "层级与布局" },
      expanded
        ? {
            key: "collapse-node",
            label: "收起当前节点",
            action: () => {
              if (node !== null) exec("SET_NODE_EXPAND", node, false);
            },
          }
        : {
            key: "expand-node",
            label: "展开当前节点",
            action: () => {
              if (node !== null) exec("SET_NODE_EXPAND", node, true);
            },
          },
      { key: "expand", label: "展开全部", action: () => exec("EXPAND_ALL") },
      { key: "collapse", label: "收起全部", action: () => exec("UNEXPAND_ALL") },
      { key: "layout", label: "一键整理布局", hint: "Ctrl+L", action: () => exec("RESET_LAYOUT") },
    ];
  }

  /** 仅思维导图布局的二级节点有效：控制分支在根节点左侧/右侧生长（子级继承）。 */
  function setNodeDir(dir: "left" | "right" | undefined): void {
    const node = ctxMenu?.node ?? null;
    const instance = instanceRef.current;
    if (node === null || instance === null) return;
    exec("SET_NODE_DATA", node, { dir });
    instance.render();
    // 直写节点数据不会触发 data_change：手动镜像最新文档并纳入自动保存。
    const snapshot = instance.getData(true);
    latestDocRef.current = snapshot;
    setDoc(snapshot);
    markDirtyAndSchedule();
  }

  const canvasMenuItems: ContextMenuItem[] = [
    { key: "paste", label: "粘贴", action: () => instanceRef.current?.renderer.paste() },
    { key: "d1", divider: true },
    { key: "select-all", label: "全选节点", action: () => exec("SELECT_ALL") },
    { key: "layout", label: "一键整理布局", action: () => exec("RESET_LAYOUT") },
    { key: "expand", label: "展开全部", action: () => exec("EXPAND_ALL") },
    { key: "collapse", label: "收起全部", action: () => exec("UNEXPAND_ALL") },
    { key: "level-2", label: "展开到二级", action: () => exec("UNEXPAND_TO_LEVEL", 2) },
    { key: "level-3", label: "展开到三级", action: () => exec("UNEXPAND_TO_LEVEL", 3) },
    { key: "fit", label: "适应画布", action: () => instanceRef.current?.view.fit() },
  ];

  // 大纲树随画布编辑实时重建（doc 状态在每次树变更时镜像最新文档）。
  const outlineRoot = doc !== null ? toOutlineTree(doc.root) : null;
  const activeIconKeys = activeNodesRef.current[0]?.getData<string[]>("icon") ?? [];

  function locateOutline(uid: string): void {
    const instance = instanceRef.current;
    if (instance === null || uid === "") return;
    const node = instance.renderer.findNodeByUid(uid);
    if (node !== null) {
      node.active();
      instance.renderer.moveNodeToCenter(node);
    }
  }

  function renameOutline(uid: string, text: string): void {
    const instance = instanceRef.current;
    if (instance === null || uid === "" || text === "") return;
    const node = instance.renderer.findNodeByUid(uid);
    if (node !== null) {
      exec("SET_NODE_TEXT", node, text);
    }
  }

  function toggleRainbow(): void {
    const instance = instanceRef.current;
    if (instance === null) return;
    const next = !rainbowOpen;
    instance.rainbowLines.updateRainLinesConfig({ open: next });
    setRainbowOpen(next);
    try {
      window.localStorage.setItem(RAINBOW_KEY, next ? "1" : "0");
    } catch {
      // 存储拒绝只影响下次打开的默认态，忽略。
    }
  }

  /** 把内置图标 + 用户图形包注入画布的图标列表并重渲染。 */
  function injectIconPacks(instance: MindMap, packs: MindMapIconPack[]): void {
    instance.opt.iconList = [
      ...nodeIconList,
      ...packs.map((pack) => ({ name: pack.name, type: pack.key, list: pack.items })),
    ];
    instance.reRender();
  }

  // 用户图形包：启动加载并注入画布（图标渲染读实例的 opt.iconList）。
  useEffect(() => {
    let cancelled = false;
    void listMindMapIconPacks().then(
      (packs) => {
        if (cancelled) return;
        setIconPacks(packs);
        const instance = instanceRef.current;
        if (instance !== null) injectIconPacks(instance, packs);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function importIconPackFiles(files: FileList): Promise<void> {
    const items: MindMapIconPackItem[] = [];
    for (const file of Array.from(files)) {
      if (file.name.toLowerCase().endsWith(".json")) {
        // 清单格式：{ name?, items: [{ name, icon }] }，icon 为 svg 文本或 dataURL。
        try {
          const parsed = JSON.parse(await file.text()) as {
            items?: { name?: string; icon?: string }[];
          };
          for (const item of parsed.items ?? []) {
            if (typeof item.icon === "string" && item.icon !== "") {
              items.push({ name: item.name ?? "图形", icon: item.icon });
            }
          }
        } catch {
          toast.error(`图形包清单解析失败：${file.name}`, { title: "导入失败" });
        }
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });
      items.push({ name: file.name.replace(/\.[^.]+$/, ""), icon: dataUrl });
    }
    if (items.length === 0) {
      toast.error("没有解析到可用图形（支持 SVG/PNG/JPG/WebP 图片或 JSON 清单）", {
        title: "导入失败",
      });
      return;
    }
    setImportingPack(true);
    try {
      const pack = await saveMindMapIconPack(`图形包 ${new Date().toLocaleString()}`, items);
      setIconPacks((prev) => [...prev, pack]);
      const instance = instanceRef.current;
      if (instance !== null) injectIconPacks(instance, iconPacksRef.current);
      toast.success(`已导入 ${pack.items.length} 个图形，可在图形库中使用`, { title: "导入完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导入失败" });
    } finally {
      setImportingPack(false);
    }
  }

  async function removeIconPack(key: string): Promise<void> {
    const pack = iconPacksRef.current.find((item) => item.key === key);
    if (pack === undefined) return;
    const confirmed = await confirm(
      `删除图形包「${pack.name}」？正在使用该包图形的节点将不再显示这些图形。`,
      { title: "删除图形包", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await deleteMindMapIconPack(key);
      const next = iconPacksRef.current.filter((item) => item.key !== key);
      setIconPacks(next);
      const instance = instanceRef.current;
      if (instance !== null) injectIconPacks(instance, next);
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除失败" });
    }
  }

  function changeLayout(layout: string): void {
    const instance = instanceRef.current;
    if (instance === null || doc === null) return;
    instance.setLayout(layout);
    const next: MindMapDoc = { ...doc, layout };
    setDoc(next);
    latestDocRef.current = instance.getData(true);
    markDirtyAndSchedule();
  }

  function applyAccent(nextAccent: string): void {
    if (doc === null) return;
    setAccentId(nextAccent);
    try {
      window.localStorage.setItem(ACCENT_KEY, nextAccent);
    } catch {
      // 隐私模式存储拒绝——仅影响下次打开的默认选中，忽略。
    }
    const config = buildThemeConfig(nextAccent, isAppDark());
    instanceRef.current?.setThemeConfig(config);
    const next: MindMapDoc = { ...doc, theme: { config } };
    setDoc(next);
    latestDocRef.current = next;
    markDirtyAndSchedule();
  }

  async function goBack(): Promise<void> {
    await doFlush();
    navigate(MINDMAP_HASH);
  }

  function utf8ToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  async function exportMap(kind: "png" | "svg" | "md" | "pdf"): Promise<void> {
    const instance = instanceRef.current;
    if (instance === null || exporting !== null) return;
    setExporting(kind);
    try {
      // isDownload=false：拿数据而不触发浏览器下载，统一落 exports/ 进生成记录。
      const result: unknown = await instance.export(kind, false, titleRef.current || "思维导图");
      let contentBase64: string;
      if (typeof result === "string" && result.startsWith("data:")) {
        // PNG/JPG 导出是 dataURL，尾段即 base64。
        contentBase64 = result.slice(result.indexOf(",") + 1);
      } else if (typeof result === "string") {
        contentBase64 = utf8ToBase64(result);
      } else {
        throw new Error("导出结果格式不符合预期");
      }
      const path = await saveMindMapExport(
        `导图-${titleRef.current || "未命名"}`,
        kind,
        contentBase64,
      );
      toast.success(`已导出到生成记录：${path}`, { title: "导出完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(null);
    }
  }

  /** 清除公式：公式是节点富文本里的 embed，复位为纯文本即整体移除。 */
  function clearFormula(): void {
    setFormulaDialogOpen(false);
    const target = formulaTargetRef.current;
    if (target === null) return;
    exec("SET_NODE_TEXT", target, String(target.getData("text") ?? ""), false, true);
  }

  function insertFormula(latex: string): void {
    setFormulaDialogOpen(false);
    const target = formulaTargetRef.current;
    if (target === null) return;
    exec("INSERT_FORMULA", latex, [target]);
  }

  /**
   * 代码块作为独立节点插入：在右键命中节点下创建一个子节点，节点内容
   * 即代码卡片（富文本 <pre>，含语言标注）。走 INSERT_CHILD_NODE 命令
   * （appointData 携带初始内容），可撤销、随 data_change 自动保存。
   */
  /**
   * 代码块保存：isNew = 在右键节点下创建代码子节点（INSERT_CHILD_NODE
   * 携带高亮 HTML）；否则替换编辑目标节点的代码内容（SET_NODE_DATA）。
   * 高亮 token 直接写进节点数据，画布渲染与各导出格式天然带色。
   */
  function handleCodeBlockSave(code: string, language: string): void {
    const edit = codeBlockEdit;
    setCodeBlockEdit(null);
    const node = edit?.node ?? null;
    const instance = instanceRef.current;
    if (node === null || instance === null) return;
    const html = buildCodeBlockHtml(code, language);
    if (edit !== null && edit.isNew) {
      exec("INSERT_CHILD_NODE", false, [node], { text: html, richText: true });
      return;
    }
    exec("SET_NODE_DATA", node, { text: html, richText: true });
    instance.render();
    // 直写节点数据不会触发 data_change：手动镜像最新文档并纳入自动保存。
    const snapshot = instance.getData(true);
    latestDocRef.current = snapshot;
    setDoc(snapshot);
    markDirtyAndSchedule();
  }

  /** 编辑对话框里的「删除代码块节点」：代码即节点，整节点删除。 */
  async function deleteCodeBlockNode(node: MindMapNodeInstance): Promise<void> {
    const confirmed = await confirm("删除这个代码块节点？它会从导图中移除，不可恢复。", {
      title: "删除代码块节点",
      kind: "warning",
    });
    if (!confirmed) return;
    setCodeBlockEdit(null);
    exec("REMOVE_NODE", [node]);
  }

  async function exportHtml(): Promise<void> {
    const instance = instanceRef.current;
    if (instance === null || exporting !== null) return;
    setExporting("html");
    try {
      // 动态 import：UMD 全量包（约 7MB）由 Vite 单独分包，仅在导出时加载，
      // 不拖累应用启动体积。
      const [{ default: umdSource }, { default: cssSource }] = await Promise.all([
        import("simple-mind-map/dist/simpleMindMap.umd.min.js?raw"),
        import("simple-mind-map/dist/simpleMindMap.esm.min.css?raw"),
      ]);
      const doc = instance.getData(true);
      const html = buildInteractiveHtml(titleRef.current || "思维导图", doc, umdSource, cssSource);
      const path = await saveMindMapExport(
        `导图-${titleRef.current || "未命名"}`,
        "html",
        utf8ToBase64(html),
      );
      toast.success(`已导出到生成记录：${path}`, { title: "导出完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(null);
    }
  }

  // ── 搜索 / 小地图 / 快捷键：纯开关，面板自身挂到实例上 ──────────────

  // ── 版本历史 ─────────────────────────────────────────────────────────

  async function refreshSnapshots(): Promise<void> {
    try {
      setSnapshots(await listMindMapSnapshots(mapId));
    } catch {
      setSnapshots([]);
    }
  }

  function toggleHistory(): void {
    setHistoryOpen((prev) => {
      if (!prev) void refreshSnapshots();
      return !prev;
    });
  }

  async function manualSnapshot(): Promise<void> {
    setSnapshotSaving(true);
    try {
      await doFlush();
      const meta = await createMindMapSnapshot(mapId, "手动快照");
      lastSnapshotAtRef.current = meta.createdAt;
      await refreshSnapshots();
      toast.success("已保存当前版本", { title: "存一版" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "快照失败" });
    } finally {
      setSnapshotSaving(false);
    }
  }

  async function restoreSnapshot(snapshot: MindMapSnapshotMeta): Promise<void> {
    const confirmed = await confirm(
      `回滚到「${snapshot.title}」（${new Date(snapshot.createdAt * 1000).toLocaleString()}）？当前内容会先自动备份成一版。`,
      { title: "回滚确认", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await doFlush();
      await restoreMindMapSnapshot(snapshot.id);
      setHistoryOpen(false);
      // 重载文档并重挂载画布（画布初始化只吃一次 props，重挂载最稳）。
      setReloadToken((token) => token + 1);
      toast.success("已回滚；回滚前的内容在历史里以「回滚备份」存在", { title: "回滚完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "回滚失败" });
    }
  }

  // ── 存为我的模板 ─────────────────────────────────────────────────────

  function handleSaveTemplate(name: string): void {
    setTemplatePromptOpen(false);
    const doc = latestDocRef.current;
    if (doc === null) return;
    void saveMindMapTemplate(name, JSON.stringify(doc))
      .then(() => toast.success("已存为我的模板，新建导图时可选", { title: "存为模板" }))
      .catch((err) => toast.error(toErrorMessage(err), { title: "保存模板失败" }));
  }

  // ── 转为白板（单向副本，原图不动） ──────────────────────────────────

  async function convertToWhiteboard(): Promise<void> {
    const doc = latestDocRef.current;
    if (doc === null || converting) return;
    setConverting(true);
    try {
      await doFlush();
      const scene = await convertDocToWhiteboardScene(doc);
      const meta = await createMindMap(`${titleRef.current || "未命名导图"} · 白板`, "whiteboard");
      await saveMindMap(meta.id, meta.title, scene);
      toast.success("已在白板中生成副本，原图保持不变", { title: "转为白板" });
      navigate(mindMapHash(meta.id));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "转为白板失败" });
      setConverting(false);
    }
  }

  // ── .xmind 导出（ExportXMind 插件直出 zip Blob） ─────────────────────

  async function exportXmind(): Promise<void> {
    const instance = instanceRef.current;
    if (instance === null || exporting !== null) return;
    setExporting("xmind");
    try {
      const blob = await instance.doExportXMind.xmind(
        instance.getData(true),
        titleRef.current || "思维导图",
      );
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
        reader.onerror = () => reject(reader.error ?? new Error("读取导出内容失败"));
        reader.readAsDataURL(blob);
      });
      const path = await saveMindMapExport(
        `导图-${titleRef.current || "未命名"}`,
        "xmind",
        contentBase64,
      );
      toast.success(`已导出到生成记录：${path}`, { title: "导出完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(null);
    }
  }

  // 白板对象：整页交给 Excalidraw 编辑器（不经导图顶栏与画布）。
  if (phase === "whiteboard") {
    return <WhiteboardEditorView mapId={mapId} />;
  }

  return (
    <div className="mm-frame">
      <div className="mm-topbar">
        <button type="button" className="mm-btn" onClick={() => void goBack()}>
          ← 返回
        </button>
        <input
          type="text"
          className="mm-title-input"
          value={title}
          placeholder="未命名导图"
          spellCheck={false}
          onChange={(event) => {
            setTitle(event.target.value);
            titleRef.current = event.target.value;
            markDirtyAndSchedule();
          }}
        />
        <span className="mm-save-state" data-state={saveState} aria-live="polite">
          {saveState === "saving" ? "保存中…" : saveState === "pending" ? "修改未保存" : "已保存"}
        </span>
        <span className="mm-topbar__spacer" aria-hidden="true" />
        <button type="button" className="mm-btn" disabled={!canUndo} onClick={() => exec("BACK")}>
          撤销
        </button>
        <button type="button" className="mm-btn" disabled={!canRedo} onClick={() => exec("FORWARD")}>
          重做
        </button>
        <button
          type="button"
          className={searchOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setSearchOpen((value) => !value)}
        >
          搜索
        </button>
        <span className="mm-topbar__divider" aria-hidden="true" />
        <button type="button" className="mm-btn" onClick={() => exec("INSERT_CHILD_NODE")}>
          子级
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={activeCount === 0}
          onClick={() => exec("INSERT_NODE")}
        >
          同级
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={activeCount === 0}
          onClick={() => exec("REMOVE_NODE")}
        >
          删除
        </button>
        <span className="mm-topbar__divider" aria-hidden="true" />
        <select
          className="mm-select"
          value={doc?.layout ?? "logicalStructure"}
          aria-label="布局"
          onChange={(event) => changeLayout(event.target.value)}
        >
          {LAYOUTS.map((layout) => (
            <option key={layout.value} value={layout.value}>
              {layout.label}
            </option>
          ))}
        </select>
        <select
          className="mm-select"
          value={accentId}
          aria-label="连线颜色"
          onChange={(event) => applyAccent(event.target.value)}
        >
          {LINE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              连线 · {preset.label}
            </option>
          ))}
        </select>
        <span className="mm-topbar__spacer" aria-hidden="true" />
        <button type="button" className="mm-btn" onClick={() => instanceRef.current?.view.fit()}>
          适应
        </button>
        <button
          type="button"
          className={outlineOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setOutlineOpen((value) => !value)}
        >
          大纲
        </button>
        <button
          type="button"
          className={rainbowOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={toggleRainbow}
        >
          彩虹连线
        </button>
        <button
          type="button"
          className={shapesOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setShapesOpen((value) => !value)}
        >
          图形库
        </button>
        <button
          type="button"
          className={minimapOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setMinimapOpen((value) => !value)}
        >
          小地图
        </button>
        <button
          type="button"
          className={historyOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={toggleHistory}
        >
          历史
        </button>
        <button
          type="button"
          className={shortcutOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setShortcutOpen((value) => !value)}
        >
          快捷键
        </button>
        <span className="mm-topbar__divider" aria-hidden="true" />
        <button type="button" className="mm-btn" onClick={() => setTemplatePromptOpen(true)}>
          存为模板
        </button>
        <button type="button" className="mm-btn" disabled={converting} onClick={() => void convertToWhiteboard()}>
          {converting ? "转换中…" : "转白板"}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportMap("png")}
        >
          {exporting === "png" ? "导出中…" : "PNG"}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportMap("svg")}
        >
          SVG
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportMap("pdf")}
        >
          PDF
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportMap("md")}
        >
          MD
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportXmind()}
        >
          {exporting === "xmind" ? "导出中…" : "XMind"}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => void exportHtml()}
        >
          HTML
        </button>
      </div>
      {phase === "ready" && doc !== null ? (
        <MindMapCanvas
          key={`${mapId}-${reloadToken}`}
          doc={doc}
          rainbow={rainbowOpen}
          onReady={(instance) => {
            instanceRef.current = instance;
            if (iconPacksRef.current.length > 0) injectIconPacks(instance, iconPacksRef.current);
          }}
          onTreeChange={() => {
            const instance = instanceRef.current;
            if (instance !== null) {
              const snapshot = instance.getData(true);
              latestDocRef.current = snapshot;
              // doc 状态同步镜像最新文档，大纲面板等内容随之实时刷新。
              setDoc(snapshot);
            }
            markDirtyAndSchedule();
          }}
          onActiveChange={(list) => {
            activeNodesRef.current = list;
            setActiveCount(list.length);
          }}
          onHistoryChange={(canUndoNext, canRedoNext) => {
            setCanUndo(canUndoNext);
            setCanRedo(canRedoNext);
          }}
          onNodeContextMenu={(node, x, y) => setCtxMenu({ x, y, node, iconsOpen: false })}
          onCanvasContextMenu={(x, y) => setCanvasMenu({ x, y })}
          onCanvasDblClick={() => {
            // 双击空白：对标 ProcessOn，在根节点下就地新建子节点并进入编辑。
            const root = instanceRef.current?.renderer.root;
            if (root !== undefined && root !== null) exec("INSERT_CHILD_NODE", true, [root]);
          }}
          onNoteClick={(node) => setNoteView(String(node.getData("note") ?? ""))}
          onCodeNodeDblClick={(node) => {
            // 双击代码节点：提取代码与语言进对话框，替换编辑（拦截了 quill 编辑）。
            const extract = extractCodeBlock(String(node.getData("text") ?? ""));
            setCodeBlockEdit({
              node,
              code: extract?.code ?? "",
              language: extract?.language ?? "",
              isNew: false,
            });
          }}
        />
      ) : (
        <div className="mm-canvas-wrap">
          {phase === "missing" ? (
            <p className="placeholder">
              导图不存在或已被删除。
              <button type="button" className="button" onClick={() => navigate(MINDMAP_HASH)}>
                返回列表
              </button>
            </p>
          ) : (
            <p className="placeholder" role="status" aria-live="polite">
              <span className="ingest__spinner" /> 正在加载导图…
            </p>
          )}
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) void handleImageFile(file);
        }}
      />
      {ctxMenu !== null && !ctxMenu.iconsOpen && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildNodeMenuItems()} onClose={() => setCtxMenu(null)} />
      )}
      {ctxMenu !== null && ctxMenu.iconsOpen && (
        <IconPicker
          x={ctxMenu.x}
          y={ctxMenu.y}
          activeIcons={ctxMenu.node.getData<string[]>("icon") ?? []}
          onToggle={(iconKey) => toggleIcon(iconKey, [ctxMenu.node])}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {canvasMenu !== null && (
        <ContextMenu x={canvasMenu.x} y={canvasMenu.y} items={canvasMenuItems} onClose={() => setCanvasMenu(null)} />
      )}
      {searchOpen && instanceRef.current !== null && (
        <SearchPanel instance={instanceRef.current} onClose={() => setSearchOpen(false)} />
      )}
      {minimapOpen && instanceRef.current !== null && (
        <MiniMapPanel instance={instanceRef.current} onClose={() => setMinimapOpen(false)} />
      )}
      {historyOpen && (
        <HistoryPanel
          snapshots={snapshots}
          saving={snapshotSaving}
          onManualSnapshot={() => void manualSnapshot()}
          onRestore={(snapshot) => void restoreSnapshot(snapshot)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {shortcutOpen && <ShortcutPanel onClose={() => setShortcutOpen(false)} />}
      {templatePromptOpen && (
        <PromptDialog
          title="存为我的模板"
          placeholder="模板名称"
          initial={title === "" ? "未命名模板" : title}
          confirmText="保存"
          onSubmit={handleSaveTemplate}
          onClose={() => setTemplatePromptOpen(false)}
        />
      )}
      {activeCount > 0 && activeNodesRef.current[0] !== undefined && (
        <StylePanel node={activeNodesRef.current[0]} onStyle={applyStyle} shifted={shapesOpen} />
      )}
      {shapesOpen && (
        <ShapesPanel
          packs={iconPacks}
          activeIcons={activeIconKeys}
          onApplyIcon={toggleIcon}
          onDeletePack={(key) => void removeIconPack(key)}
          onImportClick={() => importInputRef.current?.click()}
          importing={importingPack}
          onClose={() => setShapesOpen(false)}
        />
      )}
      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".svg,.png,.jpg,.jpeg,.webp,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const files = event.target.files;
          event.target.value = "";
          if (files !== null && files.length > 0) void importIconPackFiles(files);
        }}
      />
      {outlineOpen && outlineRoot !== null && (
        <OutlinePanel
          root={outlineRoot}
          onLocate={locateOutline}
          onRename={renameOutline}
          onClose={() => setOutlineOpen(false)}
        />
      )}
      {infoDialog !== null && (
        <NodeInfoDialog
          kind={infoDialog.kind}
          initial={infoDialog.initial}
          onSave={saveInfo}
          onClose={() => setInfoDialog(null)}
        />
      )}
      {noteView !== null && <NoteViewDialog text={noteView} onClose={() => setNoteView(null)} />}
      {formulaDialogOpen && (
        <FormulaDialog
          onSave={insertFormula}
          onClear={clearFormula}
          onClose={() => setFormulaDialogOpen(false)}
        />
      )}
      {codeBlockEdit !== null && (
        <CodeBlockDialog
          initialCode={codeBlockEdit.code}
          initialLanguage={codeBlockEdit.language}
          onSave={handleCodeBlockSave}
          onDelete={() => void deleteCodeBlockNode(codeBlockEdit.node)}
          onClose={() => setCodeBlockEdit(null)}
        />
      )}
    </div>
  );
}

export default MindMapEditorView;
