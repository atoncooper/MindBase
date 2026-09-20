"use client";

/**
 * 自由白板编辑器（全幅）：Excalidraw 画布 + 应用自己的顶栏（桌面端移植）。
 *
 * 图形/箭头/文字/画笔/图片的绘制、多选、对齐、撤销重做全部由 Excalidraw
 * 自带，这里只做集成：加载 mind_maps 行（kind = whiteboard）→ initialData
 * 恢复场景 → onChange 防抖 800ms 自动保存（序列化 elements + files + 视图
 * 相关 appState 子集）→ Ctrl+S 兜底 + 卸载 flush。导出 PNG/SVG 走浏览器
 * 下载（board-store 版 saveMindMapExport）；版本历史走 localStorage 快照。
 */

import { useEffect, useRef, useState } from "react";
import { confirm } from "../editor/web-shims";
import { MINDMAP_HASH, navigate } from "../editor/web-shims";
import {
  createMindMapSnapshot,
  getMindMap,
  listMindMapSnapshots,
  restoreMindMapSnapshot,
  saveMindMap,
  saveMindMapExport,
} from "@/lib/board-store";
import type { MindMapDetail, MindMapSnapshotMeta, WhiteboardScene } from "@/lib/board-store";
import { toErrorMessage } from "../editor/errmsg";
import { useToast } from "../editor/toast";
import { isAppDark } from "../editor/doc";
import { HistoryPanel } from "../editor/toolPanels";
import { BoardChatPanel } from "../editor/BoardChatPanel";

type SaveState = "saved" | "pending" | "saving";

/** 自动快照最小间隔：距上一版 ≥10 分钟且本次有落库才拍（与导图编辑器一致）。 */
const AUTO_SNAPSHOT_INTERVAL_SEC = 600;

/** 落库体积警告阈值（字符数 ≈ 字节数，dataURL 均为 ASCII）：app-board 单板上限 8MB。 */
const SIZE_WARN_CHARS = 6 * 1024 * 1024;

type ExcalidrawModule = typeof import("./excalidrawBundle");

/** onChange 里最新一帧的场景快照（序列化推迟到防抖 flush，动画帧零成本）。 */
interface PendingScene {
  elements: unknown[];
  files: Record<string, unknown>;
  viewBackgroundColor: string;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("读取导出内容失败"));
    reader.readAsDataURL(blob);
  });
}

function WhiteboardEditorView({ mapId, onExit }: {
  mapId: string;
  /** 「← 返回」：web 由列表视图收起编辑器；缺省走桌面端 hash 路由。 */
  onExit?: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<"loading" | "ready" | "missing">("loading");
  const [title, setTitle] = useState("");
  const [dark, setDark] = useState(isAppDark());
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [exporting, setExporting] = useState<string | null>(null);
  /** 版本历史面板（快照机制与导图共用 localStorage 快照，按板隔离）。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<MindMapSnapshotMeta[] | null>(null);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  /** 板聊侧栏（board agent 对白板只读引导：可解释内容，不改结构）。 */
  const [boardChatOpen, setBoardChatOpen] = useState(false);
  /** 回滚后递增：重载文档并重挂 Excalidraw（initialData 只在挂载时读）。 */
  const [reloadToken, setReloadToken] = useState(0);
  /** 动态分包的 Excalidraw 组件模块；加载失败时提示。 */
  const [lib, setLib] = useState<ExcalidrawModule | null>(null);
  const toast = useToast();

  const titleRef = useRef("");
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const trailingRef = useRef(false);
  const doFlushRef = useRef<() => Promise<void>>(async () => {});
  /** 体积警告只提示一次，避免每次落库刷屏。 */
  const sizeWarnedRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  /** 最近一次成功保存的序列化结果，内容没变就跳过落库。 */
  const lastSavedRef = useRef<string | null>(null);
  /** 最近一次成功保存的标题；标题单独改动不算 no-op，否则会被静默丢弃。 */
  const lastSavedTitleRef = useRef<string | null>(null);
  /** onChange 的最新一帧；flush 时才序列化。 */
  const pendingRef = useRef<PendingScene | null>(null);
  /** 最近一次快照时间（秒）；自动快照按此判断间隔。 */
  const lastSnapshotAtRef = useRef(0);
  /** 回滚进行中：挡住 Excalidraw 持续 onChange 触发的尾部落库覆盖回滚结果。 */
  const restoringRef = useRef(false);

  function scheduleSave(): void {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setSaveState("pending");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void doFlushRef.current();
    }, 800);
  }

  function markDirty(): void {
    dirtyRef.current = true;
    scheduleSave();
  }

  async function doFlush(): Promise<void> {
    if (restoringRef.current) return;
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
    const pending = pendingRef.current;
    if (pending === null) return;
    const scene: WhiteboardScene = {
      type: "excalidraw",
      version: 1,
      elements: pending.elements,
      files: pending.files,
      appState: {
        viewBackgroundColor: pending.viewBackgroundColor,
        scrollX: pending.scrollX,
        scrollY: pending.scrollY,
        zoom: { value: pending.zoom },
      },
    };
    const serialized = JSON.stringify(scene);
    if (serialized === lastSavedRef.current && titleRef.current === lastSavedTitleRef.current) {
      // Scene AND title both identical to the last save -> true no-op
      // (suppresses saves triggered by Excalidraw pan/zoom onChange).
      dirtyRef.current = false;
      setSaveState("saved");
      return;
    }
    // app-board 单板上限 8MB：贴大截图会随 files 一起存，超限后保存直接失败。
    // 只提示一次；阈值 6MB 留出余量。
    if (serialized.length > SIZE_WARN_CHARS && !sizeWarnedRef.current) {
      sizeWarnedRef.current = true;
      toast.info("白板内容较大，接近存储上限（8MB）——大图建议压缩后再插入，否则可能无法保存", {
        title: "体积提示",
      });
    }
    inFlightRef.current = true;
    dirtyRef.current = false;
    setSaveState("saving");
    try {
      await saveMindMap(mapId, titleRef.current, scene);
      lastSavedRef.current = serialized;
      lastSavedTitleRef.current = titleRef.current;
      setSaveState("saved");
      // 落库成功 → 距上一版超过间隔就顺手拍一版自动快照（失败静默）。
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - lastSnapshotAtRef.current >= AUTO_SNAPSHOT_INTERVAL_SEC) {
        lastSnapshotAtRef.current = nowSec;
        void createMindMapSnapshot(mapId).catch(() => undefined);
      }
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

  // 加载白板文档；卸载/换对象前兜底 flush。回滚快照后经 reloadToken
  // 重跑本 effect 重取内容，再以新 key 重挂 Excalidraw（initialData 只吃一次）。
  useEffect(() => {
    let cancelled = false;
    void getMindMap(mapId).then(
      (detail: MindMapDetail | null) => {
        if (cancelled) return;
        if (detail === null || detail.kind !== "whiteboard") {
          setPhase("missing");
          return;
        }
        setTitle(detail.title);
        titleRef.current = detail.title;
        if (detail.data !== "") {
          try {
            const scene = JSON.parse(detail.data) as WhiteboardScene;
            pendingRef.current = {
              elements: Array.isArray(scene.elements) ? scene.elements : [],
              files: scene.files ?? {},
              viewBackgroundColor: scene.appState?.viewBackgroundColor ?? "transparent",
              scrollX: scene.appState?.scrollX ?? 0,
              scrollY: scene.appState?.scrollY ?? 0,
              zoom: scene.appState?.zoom?.value ?? 1,
            };
            lastSavedRef.current = detail.data;
            lastSavedTitleRef.current = detail.title;
          } catch {
            // 场景损坏则从空白开始，用户重画比报错卡死更好。
            pendingRef.current = null;
          }
        }
        setPhase("ready");
        // 回滚重载完成：恢复自动保存（见 restoringRef）。
        restoringRef.current = false;
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

  // 动态加载 Excalidraw（单独分包）。
  useEffect(() => {
    let cancelled = false;
    void import("./excalidrawBundle").then(
      (mod) => {
        if (!cancelled) setLib(mod);
      },
      (err) => {
        if (!cancelled) toast.error(toErrorMessage(err), { title: "白板组件加载失败" });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 应用主题切档（Navbar 深浅切换）→ 画布实时重配色。
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isAppDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Ctrl+S 手动保存（Excalidraw 不占用该组合键，这里是全局兜底）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void doFlushRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSceneChange(elements: readonly unknown[], appState: unknown, files: unknown): void {
    const state = appState as {
      viewBackgroundColor?: string;
      scrollX?: number;
      scrollY?: number;
      zoom?: { value: number };
    };
    const filesRecord = (files ?? {}) as Record<string, unknown>;
    pendingRef.current = {
      elements: [...elements],
      files: filesRecord,
      viewBackgroundColor: state.viewBackgroundColor ?? "transparent",
      scrollX: state.scrollX ?? 0,
      scrollY: state.scrollY ?? 0,
      zoom: state.zoom?.value ?? 1,
    };
    markDirty();
  }

  async function exportBoard(mod: ExcalidrawModule, kind: "png" | "svg"): Promise<void> {
    if (exporting !== null) return;
    const pending = pendingRef.current;
    if (pending === null || pending.elements.length === 0) {
      toast.error("白板还是空的，先画点什么再导出吧", { title: "导出失败" });
      return;
    }
    setExporting(kind);
    try {
      const elements = mod.getNonDeletedElements(
        pending.elements as Parameters<typeof mod.getNonDeletedElements>[0],
      );
      const appState = {
        viewBackgroundColor: pending.viewBackgroundColor,
        exportBackground: true,
      };
      let contentBase64: string;
      if (kind === "png") {
        const blob = await mod.exportToBlob({
          elements,
          appState,
          files: pending.files as never,
          mimeType: "image/png",
        });
        contentBase64 = await blobToBase64(blob);
      } else {
        const svg = await mod.exportToSvg({
          elements,
          appState,
          files: pending.files as never,
          skipInliningFonts: true,
        });
        contentBase64 = utf8ToBase64(svg.outerHTML);
      }
      const path = await saveMindMapExport(`白板-${titleRef.current || "未命名"}`, kind, contentBase64);
      toast.success(`已导出：${path}`, { title: "导出完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(null);
    }
  }

  /** 导出 .excalidraw 源文件（完整场景，可经「导入」回灌或与桌面端互用）。 */
  async function exportSceneFile(): Promise<void> {
    if (exporting !== null) return;
    const pending = pendingRef.current;
    if (pending === null || pending.elements.length === 0) {
      toast.error("白板还是空的，先画点什么再导出吧", { title: "导出失败" });
      return;
    }
    setExporting("file");
    try {
      const scene: WhiteboardScene = {
        type: "excalidraw",
        version: 1,
        elements: pending.elements,
        files: pending.files,
        appState: {
          viewBackgroundColor: pending.viewBackgroundColor,
          scrollX: pending.scrollX,
          scrollY: pending.scrollY,
          zoom: { value: pending.zoom },
        },
      };
      const contentBase64 = utf8ToBase64(JSON.stringify(scene));
      const path = await saveMindMapExport(
        `白板-${titleRef.current || "未命名"}`,
        "excalidraw",
        contentBase64,
      );
      toast.success(`已导出：${path}`, { title: "导出完成" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    } finally {
      setExporting(null);
    }
  }

  /** 导入 .excalidraw 场景：先备份当前内容一版，再落库并按回滚同款路径重挂画布。 */
  async function importSceneFile(file: File): Promise<void> {
    let parsed: Partial<WhiteboardScene>;
    try {
      parsed = JSON.parse(await file.text()) as Partial<WhiteboardScene>;
    } catch {
      toast.error("文件不是合法的 JSON", { title: "导入失败" });
      return;
    }
    if (parsed.type !== "excalidraw" || !Array.isArray(parsed.elements)) {
      toast.error("不是有效的 .excalidraw 场景文件", { title: "导入失败" });
      return;
    }
    const confirmed = await confirm(
      "导入会覆盖当前白板内容（覆盖前自动备份一版），确定吗？",
      { title: "导入确认", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await doFlush();
      restoringRef.current = true;
      const appState = parsed.appState ?? {};
      const scene: WhiteboardScene = {
        type: "excalidraw",
        version: 1,
        elements: parsed.elements,
        files: parsed.files ?? {},
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor ?? "transparent",
          scrollX: appState.scrollX ?? 0,
          scrollY: appState.scrollY ?? 0,
          zoom: appState.zoom ?? { value: 1 },
        },
      };
      await createMindMapSnapshot(mapId, "导入前备份");
      await saveMindMap(mapId, titleRef.current, scene);
      lastSavedRef.current = null;
      lastSavedTitleRef.current = null;
      setHistoryOpen(false);
      // 与回滚同款重挂路径：先回 loading 再重跑加载 effect（initialData 只吃一次）。
      setPhase("loading");
      setReloadToken((token) => token + 1);
      toast.success(`已导入 ${parsed.elements.length} 个元素`, { title: "导入完成" });
    } catch (err) {
      restoringRef.current = false;
      toast.error(toErrorMessage(err), { title: "导入失败" });
    }
  }

  // ── 版本历史（与导图共用快照机制） ───────────────────────────────────

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
      restoringRef.current = true;
      await restoreMindMapSnapshot(snapshot.id);
      setHistoryOpen(false);
      // 先回 loading 再重取内容：Excalidraw 的 initialData 只在挂载时读，
      // 直接换 key 会拿到旧场景；重跑加载 effect 后以新 key 重挂最稳。
      setPhase("loading");
      setReloadToken((token) => token + 1);
      toast.success("已回滚；回滚前的内容在历史里以「回滚备份」存在", { title: "回滚完成" });
    } catch (err) {
      restoringRef.current = false;
      toast.error(toErrorMessage(err), { title: "回滚失败" });
    }
  }

  function goBack(): void {
    if (onExit !== undefined) onExit();
    else navigate(MINDMAP_HASH);
  }

  if (phase !== "ready") {
    return (
      <div className="mm-canvas-wrap wb-frame">
        {phase === "missing" ? (
          <p className="placeholder">
            白板不存在或已被删除。
            <button type="button" className="button" onClick={goBack}>
              返回列表
            </button>
          </p>
        ) : (
          <p className="placeholder" role="status" aria-live="polite">
            <span className="ingest__spinner" /> 正在加载白板…
          </p>
        )}
      </div>
    );
  }

  const Excalidraw = lib?.Excalidraw;

  return (
    <div className="mm-frame wb-frame">
      <div className="mm-topbar">
        <button type="button" className="mm-btn" onClick={goBack}>
          ← 返回
        </button>
        <input
          type="text"
          className="mm-title-input"
          value={title}
          placeholder="未命名白板"
          spellCheck={false}
          onChange={(event) => {
            setTitle(event.target.value);
            titleRef.current = event.target.value;
            markDirty();
          }}
        />
        <span className="mm-save-state" data-state={saveState} aria-live="polite">
          {saveState === "saving" ? "保存中…" : saveState === "pending" ? "修改未保存" : "已保存"}
        </span>
        <span className="mm-topbar__spacer" aria-hidden="true" />
        <button
          type="button"
          className={boardChatOpen ? "mm-btn mm-btn--active" : "mm-btn"}
          onClick={() => setBoardChatOpen(true)}
        >
          板聊
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
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => lib !== null && void exportBoard(lib, "png")}
        >
          {exporting === "png" ? "导出中…" : "PNG"}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          onClick={() => lib !== null && void exportBoard(lib, "svg")}
        >
          {exporting === "svg" ? "导出中…" : "SVG"}
        </button>
        <button
          type="button"
          className="mm-btn"
          disabled={exporting !== null}
          title="导出 .excalidraw 源文件（可再导入，或与桌面端互用）"
          onClick={() => void exportSceneFile()}
        >
          {exporting === "file" ? "导出中…" : "文件"}
        </button>
        <button
          type="button"
          className="mm-btn"
          title="导入 .excalidraw 场景文件（覆盖当前内容，覆盖前自动备份）"
          onClick={() => importInputRef.current?.click()}
        >
          导入
        </button>
      </div>
      <div className="wb-canvas">
        {lib === null || Excalidraw === undefined ? (
          <p className="placeholder" role="status" aria-live="polite">
            <span className="ingest__spinner" /> 正在加载白板组件…
          </p>
        ) : (
          <Excalidraw
            key={reloadToken}
            theme={dark ? "dark" : "light"}
            langCode="zh-CN"
            initialData={
              pendingRef.current !== null && pendingRef.current.elements.length > 0
                ? ({
                    elements: pendingRef.current.elements,
                    appState: {
                      viewBackgroundColor: pendingRef.current.viewBackgroundColor,
                      scrollX: pendingRef.current.scrollX,
                      scrollY: pendingRef.current.scrollY,
                      zoom: { value: pendingRef.current.zoom },
                    },
                    files: pendingRef.current.files,
                  } as never)
                : null
            }
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                saveAsImage: false,
                export: false,
                toggleTheme: false,
              },
            }}
            onChange={(elements, appState, files) => handleSceneChange(elements, appState, files)}
          />
        )}
      </div>
      {historyOpen && (
        <HistoryPanel
          snapshots={snapshots}
          saving={snapshotSaving}
          onManualSnapshot={() => void manualSnapshot()}
          onRestore={(snapshot) => void restoreSnapshot(snapshot)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {boardChatOpen && (
        <BoardChatPanel
          boardUuid={mapId}
          boardTitle={titleRef.current || "未命名白板"}
          onClose={() => setBoardChatOpen(false)}
        />
      )}
      <input
        ref={importInputRef}
        type="file"
        accept=".excalidraw,.json"
        style={{ display: "none" }}
        onChange={(event) => {
          const files = event.target.files;
          event.target.value = "";
          const file = files?.[0];
          if (file !== undefined) void importSceneFile(file);
        }}
      />
    </div>
  );
}

export default WhiteboardEditorView;
