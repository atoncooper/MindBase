/**
 * simple-mind-map 的薄 React 封装。
 *
 * 库是命令式的：构造即渲染、自持 SVG 画布与全局事件。这里只负责生命周期
 * 与事件桥接——实例经 onReady 交给父级（工具栏/右键菜单直接调库命令），
 * 树变更 / 选中变化 / 撤销栈 / 右键 / 备注点击经回调上抛。StrictMode 双挂载
 * 下 init/destroy 必须严格成对（destroy + 清空容器），否则画布会叠两层。
 *
 * 画布手势约定（参考 ProcessOn）：空白处左键拖拽 = 整体平移画布；
 * Ctrl/Meta + 空白拖拽（或右键拖拽）= 框选多选；节点拖拽 = 换父级挂载点，
 * 单个节点拖到空白处 = 自由定位（enableFreeDrag，位置存进节点数据）。
 *
 * 节点尺寸调节：选中单个节点时显示四向手柄——左右拖拽调整文本换行宽度
 * （customTextWidth），上下拖拽调整节点纵向内边距（paddingY，节点级样式
 * 覆盖主题），松手落盘并随整卡自动保存。库内置的隐形调宽热区关闭，统一
 * 走这里的可见手柄。
 */

import { useEffect, useRef, useState } from "react";
import MindMap from "simple-mind-map";
import Drag from "simple-mind-map/src/plugins/Drag.js";
import Export from "simple-mind-map/src/plugins/Export.js";
import ExportPDF from "simple-mind-map/src/plugins/ExportPDF.js";
import ExportXMind from "simple-mind-map/src/plugins/ExportXMind.js";
import OuterFrame from "simple-mind-map/src/plugins/OuterFrame.js";
import AssociativeLine from "simple-mind-map/src/plugins/AssociativeLine.js";
import Select from "simple-mind-map/src/plugins/Select.js";
import RichText from "simple-mind-map/src/plugins/RichText.js";
import Formula from "simple-mind-map/src/plugins/Formula.js";
import Search from "simple-mind-map/src/plugins/Search.js";
import MiniMap from "simple-mind-map/src/plugins/MiniMap.js";
import { nodeIconList } from "simple-mind-map/src/svg/icons.js";
// 公式渲染依赖 KaTeX 的样式与字体（Vite 会把字体一并打包）。
import "katex/dist/katex.min.css";

import type { MindMapDoc } from "@/lib/board-store";
import type { MindMapNodeInstance } from "simple-mind-map";
import { isCodeBlockText } from "./codeBlock";
import { isMdCardText } from "./mdCard";

// 插件模块级注册一次：拖拽、导出（PDF = Export 先转 PNG 再经 ExportPDF/
// pdf-lib 打包；XMind = ExportXMind 产 zip）、外框、关联线、框选多选、
// 富文本与 LaTeX 公式、搜索替换、小地图。
MindMap.usePlugin(Drag);
MindMap.usePlugin(Export);
MindMap.usePlugin(ExportPDF);
MindMap.usePlugin(ExportXMind);
MindMap.usePlugin(OuterFrame);
MindMap.usePlugin(AssociativeLine);
MindMap.usePlugin(Select);
MindMap.usePlugin(RichText);
MindMap.usePlugin(Formula);
MindMap.usePlugin(Search);
MindMap.usePlugin(MiniMap);

type ResizeDirection = "left" | "right" | "top" | "bottom";

interface ResizeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface MindMapCanvasProps {
  doc: MindMapDoc;
  /** 彩虹连线初始态（挂载时读取；运行时切换走实例的 updateRainLinesConfig）。 */
  rainbow: boolean;
  onReady: (instance: MindMap) => void;
  /** 任意命令提交后的树变更（autosave 触发点）。 */
  onTreeChange: () => void;
  /** 选中集合变化（含框选多选），样式面板/按钮状态由此驱动。 */
  onActiveChange: (activeNodeList: MindMapNodeInstance[]) => void;
  /** (index, length) → canUndo / canRedo。 */
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
  /** 节点右键（坐标为视口坐标，此时该节点已被库置为激活）。 */
  onNodeContextMenu: (node: MindMapNodeInstance, x: number, y: number) => void;
  /** 画布空白处右键。 */
  onCanvasContextMenu: (x: number, y: number) => void;
  /** 双击画布空白处（对标 ProcessOn：就地新建节点，挂到根下）。 */
  onCanvasDblClick: () => void;
  /** 点击节点上的备注图标。 */
  onNoteClick: (node: MindMapNodeInstance) => void;
  /** 双击代码块节点（已在捕获阶段拦掉库的 quill 文本编辑）。 */
  onCodeNodeDblClick: (node: MindMapNodeInstance) => void;
  /** 双击 Markdown 渲染节点（同上，改开源码对话框）。 */
  onMdNodeDblClick: (node: MindMapNodeInstance) => void;
}

function MindMapCanvas(props: MindMapCanvasProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 回调经 ref 转发，事件处理永远读到最新一帧的闭包。
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  const instanceRef = useRef<MindMap | null>(null);
  // 节点右键必须走库的 node_contextmenu 事件：库在节点 group 的 contextmenu
  // 处理器里调用了 e.stopPropagation()，原生事件到不了容器层的 React 委托，
  // 所以"容器 onContextMenu 读 ref"的路径对节点右键永远不触发。
  // node_mousedown 只用于区分"按在节点上"（禁用平移）和双击目标识别。
  const nodeDownRef = useRef<MindMapNodeInstance | null>(null);
  /** 最近一次按下的节点（双击代码节点识别用；不随容器 mousedown 复位）。 */
  const lastClickedNodeRef = useRef<MindMapNodeInstance | null>(null);
  // ── 节点四向调节手柄 ──
  const activeNodeRef = useRef<MindMapNodeInstance | null>(null);
  const [resizeBox, setResizeBox] = useState<ResizeBox | null>(null);
  const resizeBoxRef = useRef<ResizeBox | null>(null);
  const rafRef = useRef(0);
  // 垂直拖拽（纵向内边距）实时应用的合帧句柄与最新值。
  const padRafRef = useRef(0);
  const pendingPaddingYRef = useRef<number | null>(null);
  // 右下角缩放控件的百分比显示（view_data_change 携带最新 scale）。
  const [scalePct, setScalePct] = useState(100);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const instance = new MindMap({
      el,
      data: props.doc.root,
      layout: props.doc.layout ?? "logicalStructure",
      theme: "default",
      fit: true,
      // 滚轮直接缩放；快捷键只在鼠标悬停画布内生效，避免劫持顶栏标题
      // 输入框的 Ctrl+Z / Tab。
      mousewheelAction: "zoom",
      enableShortcutOnlyWhenMouseInSvg: true,
      // 单个节点拖到空白处 = 自由定位（customLeft/customTop 存进节点数据）。
      enableFreeDrag: true,
      // 自定义宽度机制的总开关：关掉它 hasCustomWidth() 恒为 false，
      // customTextWidth 会被引擎完全忽略（节点级宽度调节依赖此开关）。
      enableDragModifyNodeWidth: true,
      // 节点可选图标（优先级/旗标/进度等），图形库侧边栏共用这份列表。
      iconList: nodeIconList,
      // 彩虹连线（分支按层级自动配色），工具栏可运行时开关。
      rainbowLinesConfig: { open: props.rainbow },
      // 节点 hover/激活描边框颜色：库默认是亮青蓝，与画布主题不搭；
      // 统一成应用强调蓝（与框选矩形同族），选中状态一眼可辨。
      hoverRectColor: "rgb(0, 113, 227)",
    });
    if (props.doc.theme?.config !== undefined) {
      instance.setThemeConfig(props.doc.theme.config);
    }
    instanceRef.current = instance;

    // 库默认把 Ctrl+I 绑成 fit()、Ctrl+= / Ctrl+- 绑成缩放步进，与编辑器
    // 全局快捷键双重触发：按 Ctrl+I 出补全的同时视图会被 fit 回 100% 并
    // 居中，缩放键一次跳两步。这几颗键统一交给 MindMapEditorView 的全局
    // 处理器，这里摘除库内绑定。
    instance.keyCommand.removeShortcut("Control+i");
    instance.keyCommand.removeShortcut("Control+=");
    instance.keyCommand.removeShortcut("Control+-");

    const onTreeChange = (): void => callbacksRef.current.onTreeChange();
    const onActive = (_node: unknown, activeNodeList: MindMapNodeInstance[]): void => {
      activeNodeRef.current = activeNodeList.length === 1 ? activeNodeList[0] : null;
      scheduleUpdateResizeBox();
      callbacksRef.current.onActiveChange(activeNodeList);
    };
    const onHistory = (index: number, length: number): void => {
      callbacksRef.current.onHistoryChange(index > 0, index < length - 1);
    };
    const onNodeContextMenu = (e: MouseEvent, node: MindMapNodeInstance): void => {
      // 直接用库事件携带的原生坐标打开节点菜单（见 ref 定义处的说明）。
      callbacksRef.current.onNodeContextMenu(node, e.clientX, e.clientY);
    };
    const onNoteClick = (node: MindMapNodeInstance): void => {
      callbacksRef.current.onNoteClick(node);
    };
    const onNodeMousedown = (node: MindMapNodeInstance): void => {
      nodeDownRef.current = node;
      lastClickedNodeRef.current = node;
    };
    const onViewOrRenderChange = (): void => {
      // 平移 / 缩放 / 布局重排后，手柄框要跟着节点走。
      scheduleUpdateResizeBox();
    };
    const onViewDataChange = (data: {
      state?: { scale?: number };
      transform?: { scaleX?: number };
    }): void => {
      const scale = data?.state?.scale ?? data?.transform?.scaleX ?? 1;
      setScalePct(Math.round(scale * 100));
    };
    instance.on("data_change", onTreeChange);
    instance.on("node_active", onActive);
    instance.on("back_forward", onHistory);
    instance.on("node_contextmenu", onNodeContextMenu);
    instance.on("node_note_click", onNoteClick);
    instance.on("node_mousedown", onNodeMousedown);
    instance.on("view_data_change", onViewOrRenderChange);
    instance.on("view_data_change", onViewDataChange);
    instance.on("node_tree_render_end", onViewOrRenderChange);
    callbacksRef.current.onReady(instance);

    const onResize = (): void => instance.resize();
    window.addEventListener("resize", onResize);
    // 代码/Markdown 卡片内滚轮：卡片可滚时在捕获阶段拦下 wheel（库的缩放
    // 监听在同一容器上、bubble 相，捕获先于 bubble 触发），滚动留给卡片
    // 自身，不触发画布缩放。方向感知：卡片已滚到边界时放行给画布缩放。
    const onWheelCapture = (event: WheelEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scrollEl = target.closest(".smm-code-scroll, .smm-md-card");
      if (scrollEl === null) return;
      const atTop = scrollEl.scrollTop <= 0;
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1;
      if (event.deltaY > 0 ? atBottom : atTop) return;
      event.stopPropagation();
    };
    el.addEventListener("wheel", onWheelCapture, true);
    // 双击：捕获阶段先于库的深层监听。代码/MD 节点双击 → 拦下库的 quill
    // 编辑改开对话框；空白双击 → 回调给编辑器就地新建节点（对标 ProcessOn）。
    const onNativeDblClick = (event: MouseEvent): void => {
      const node = lastClickedNodeRef.current;
      if (node !== null && isMdCardText(String(node.getData<string>("text") ?? ""))) {
        event.preventDefault();
        event.stopPropagation();
        callbacksRef.current.onMdNodeDblClick(node);
        return;
      }
      if (node !== null && isCodeBlockText(String(node.getData<string>("text") ?? ""))) {
        event.preventDefault();
        event.stopPropagation();
        callbacksRef.current.onCodeNodeDblClick(node);
        return;
      }
      const target = event.target;
      const svgRoot = containerRef.current?.querySelector("svg");
      if (target instanceof Element && svgRoot !== null && target === svgRoot) {
        event.preventDefault();
        event.stopPropagation();
        callbacksRef.current.onCanvasDblClick();
      }
    };
    el.addEventListener("dblclick", onNativeDblClick, true);

    return () => {
      window.removeEventListener("resize", onResize);
      el.removeEventListener("wheel", onWheelCapture, true);
      el.removeEventListener("dblclick", onNativeDblClick, true);
      instance.off("data_change", onTreeChange);
      instance.off("node_active", onActive);
      instance.off("back_forward", onHistory);
      instance.off("node_contextmenu", onNodeContextMenu);
      instance.off("node_note_click", onNoteClick);
      instance.off("node_mousedown", onNodeMousedown);
      instance.off("view_data_change", onViewOrRenderChange);
      instance.off("view_data_change", onViewDataChange);
      instance.off("node_tree_render_end", onViewOrRenderChange);
      instance.destroy();
      el.innerHTML = "";
      instanceRef.current = null;
    };
    // 初始化仅一次；布局/主题由父级经实例命令动态应用（见编辑器）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 把选中节点的包围盒换算成画布容器内的坐标（rAF 合帧，平移缩放时高效）。 */
  function scheduleUpdateResizeBox(): void {
    if (rafRef.current !== 0) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      updateResizeBox();
    });
  }

  function updateResizeBox(): void {
    const node = activeNodeRef.current;
    const wrap = wrapRef.current;
    if (node === null || wrap === null) {
      resizeBoxRef.current = null;
      setResizeBox(null);
      return;
    }
    try {
      const box = node.group.rbox();
      const rect = wrap.getBoundingClientRect();
      const next: ResizeBox = {
        left: box.x - rect.left,
        top: box.y - rect.top,
        width: box.width,
        height: box.height,
      };
      resizeBoxRef.current = next;
      setResizeBox(next);
    } catch {
      // 节点可能在重渲染间隙被回收，下一帧事件会再刷新。
      resizeBoxRef.current = null;
      setResizeBox(null);
    }
  }

  /** 空白处左键按下：进入整体平移（Ctrl/Meta 留给框选；节点上按下不平移）。 */
  function beginPan(event: React.MouseEvent, pressedOnNode: boolean): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || pressedOnNode) return;
    // 只有按在真正的空白处（SVG 根元素自身）才平移；按在关联线、外框等
    // 图元上要让给库的原生交互（选中、拖控制点调弯曲、双击编辑文字），
    // 否则平移会把它们的拖拽事件整体劫持掉。
    const target = event.target;
    const svgRoot = containerRef.current?.querySelector("svg");
    if (!(target instanceof Element) || svgRoot === null || target !== svgRoot) return;
    const instance = instanceRef.current;
    if (instance === null) return;
    let lastX = event.clientX;
    let lastY = event.clientY;
    const onMove = (moveEvent: MouseEvent): void => {
      instance.view.translateXY(moveEvent.clientX - lastX, moveEvent.clientY - lastY);
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** 高度（纵向内边距）实时应用：整树重排较重，rAF 逐帧限流。 */
  function scheduleApplyPaddingY(): void {
    if (padRafRef.current !== 0) return;
    padRafRef.current = window.requestAnimationFrame(() => {
      padRafRef.current = 0;
      const node = activeNodeRef.current;
      const instance = instanceRef.current;
      const paddingY = pendingPaddingYRef.current;
      if (node === null || instance === null || paddingY === null) return;
      node.setData({ paddingY });
      instance.render();
    });
  }

  /** 四向拖拽：左右实时调宽（与库内置调宽同机制），上下实时调纵向内边距。 */
  function beginResize(direction: ResizeDirection, event: React.MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const node = activeNodeRef.current;
    const instance = instanceRef.current;
    const startBox = resizeBoxRef.current;
    if (node === null || instance === null || startBox === null) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth =
      typeof node.customTextWidth === "number" ? node.customTextWidth : startBox.width;
    const startPaddingY = node.getData<number>("paddingY") ?? 5;
    let lastDx = 0;
    let lastDy = 0;
    const horizontal = direction === "left" || direction === "right";
    const onMove = (ev: MouseEvent): void => {
      lastDx = ev.clientX - startX;
      lastDy = ev.clientY - startY;
      if (horizontal) {
        // 宽度实时生效（只重排文本，与库内置调宽完全一致）；手柄框由
        // node_tree_render_end 事件驱动跟随真实节点，无需手动预览。
        node.customTextWidth = Math.max(
          40,
          Math.round(startWidth + (direction === "right" ? lastDx : -lastDx)),
        );
        node.reRender(["text"], { ignoreUpdateCustomTextWidth: true });
      } else {
        // 高度（纵向内边距）同样实时生效；手柄框跟随真实节点。
        const delta = direction === "bottom" ? lastDy : -lastDy;
        pendingPaddingYRef.current = Math.max(0, Math.round(startPaddingY + delta));
        scheduleApplyPaddingY();
      }
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (horizontal) {
        const width = Math.max(
          40,
          Math.round(startWidth + (direction === "right" ? lastDx : -lastDx)),
        );
        node.customTextWidth = width;
        node.setData({ customTextWidth: width });
      } else {
        const paddingY = pendingPaddingYRef.current;
        pendingPaddingYRef.current = null;
        node.setData({ paddingY: paddingY ?? (node.getData<number>("paddingY") ?? 5) });
      }
      instance.render();
      // 直写节点 data 不走库命令，不会触发 data_change——这里手动通知
      // 编辑器把最新文档纳入自动保存。
      callbacksRef.current.onTreeChange();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className="mm-canvas-wrap"
      ref={wrapRef}
      onContextMenu={(event) => {
        // 只承载画布空白处菜单：节点右键被库 stopPropagation 拦下、到不了
        // 这一层，节点菜单由 node_contextmenu 事件直接打开（见上）。
        event.preventDefault();
        callbacksRef.current.onCanvasContextMenu(event.clientX, event.clientY);
      }}
      onMouseDown={(event) => {
        const pressedNode = nodeDownRef.current;
        nodeDownRef.current = null;
        // 空白按下清除双击目标：防止"点过代码节点后再双击空白"被误判为
        // 代码节点双击。
        if (pressedNode === null) lastClickedNodeRef.current = null;
        beginPan(event, pressedNode !== null);
      }}
    >
      <div className="mm-canvas" ref={containerRef} />
      <div className="mm-zoom" role="group" aria-label="缩放控制">
        <button
          type="button"
          className="mm-zoom__btn"
          title="缩小（Ctrl+-）"
          onClick={() => instanceRef.current?.view.narrow()}
        >
          −
        </button>
        <button
          type="button"
          className="mm-zoom__pct"
          title="点击恢复 100%"
          onClick={() => instanceRef.current?.view.setScale(1)}
        >
          {scalePct}%
        </button>
        <button
          type="button"
          className="mm-zoom__btn"
          title="放大（Ctrl+=）"
          onClick={() => instanceRef.current?.view.enlarge()}
        >
          ＋
        </button>
        <span className="mm-zoom__divider" aria-hidden="true" />
        <button
          type="button"
          className="mm-zoom__btn"
          title="适应画布（Ctrl+0）"
          onClick={() => instanceRef.current?.view.fit()}
        >
          ⛶
        </button>
      </div>
      {resizeBox !== null && (
        <div
          className="mm-resize-box"
          style={{ left: resizeBox.left, top: resizeBox.top, width: resizeBox.width, height: resizeBox.height }}
        >
          {(["left", "right", "top", "bottom"] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              className={`mm-resize-handle mm-resize-handle--${direction}`}
              title={direction === "left" || direction === "right" ? "拖拽调整宽度" : "拖拽调整高度"}
              onMouseDown={(event) => beginResize(direction, event)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default MindMapCanvas;
