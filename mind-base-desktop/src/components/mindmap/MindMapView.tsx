/**
 * 知识导图 / 自由白板入口页：新建 + 库列表（打开 / 重命名 / 删除）。
 * 两类对象共用 mind_maps 表（kind 列区分），页内 Tab 切换；列表行复用
 * ws-doc 样式。点开任一对象都进 #/mindmap/:id，编辑器按 kind 分发。
 */

import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { mindMapHash, navigate } from "../../lib/router";
import {
  createMindMap,
  deleteMindMap,
  deleteMindMapTemplate,
  listMindMaps,
  listMindMapTemplates,
  renameMindMap,
  saveMindMap,
} from "../../lib/mindmap";
import type { MindMapMeta, MindObjectKind } from "../../lib/mindmap";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";
import { TemplateDialog } from "./toolPanels";
import { BUILTIN_TEMPLATES } from "./templates";
import type { MindMapTemplateDef } from "./templates";
import { transformMarkdownTo } from "simple-mind-map/src/parse/markdownTo.js";
import xmindParser from "simple-mind-map/src/parse/xmind.js";

const KIND_TABS: ReadonlyArray<{ kind: MindObjectKind; label: string }> = [
  { kind: "mindmap", label: "导图" },
  { kind: "whiteboard", label: "白板" },
];

function MindMapView(): React.JSX.Element {
  const [kind, setKind] = useState<MindObjectKind>("mindmap");
  const [maps, setMaps] = useState<MindMapMeta[] | null>(null);
  const [creating, setCreating] = useState(false);
  /** 正在内联重命名的对象 id；草稿单独存，Enter/失焦提交、Esc 取消。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** 新建时的模板选择对话框；用户模板列表随对话框打开时拉取。 */
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [userTemplates, setUserTemplates] = useState<import("../../lib/mindmap").MindMapTemplate[]>([]);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    setMaps(null);
    void listMindMaps(kind).then(
      (rows) => {
        if (!cancelled) setMaps(rows);
      },
      () => {
        if (!cancelled) setMaps([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind]);

  async function create(templateData?: string): Promise<void> {
    setCreating(true);
    try {
      const meta = await createMindMap(undefined, kind);
      if (templateData !== undefined) {
        await saveMindMap(meta.id, meta.title, JSON.parse(templateData) as never);
      }
      navigate(mindMapHash(meta.id));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "新建失败" });
      setCreating(false);
    }
  }

  /** 点「新建导图」→ 弹模板选择；白板直接建（本轮无白板模板）。 */
  function handleCreateClick(): void {
    if (kind === "whiteboard") {
      void create();
      return;
    }
    setTemplateDialogOpen(true);
    void listUserTemplates();
  }

  async function listUserTemplates(): Promise<void> {
    try {
      setUserTemplates(await listMindMapTemplates());
    } catch {
      setUserTemplates([]);
    }
  }

  /** 模板选中（null = 空白导图）。 */
  async function handlePickTemplate(template: { name: string; data: string } | null): Promise<void> {
    setTemplateDialogOpen(false);
    await create(template?.data);
  }

  async function handleDeleteUserTemplate(key: string): Promise<void> {
    try {
      await deleteMindMapTemplate(key);
      setUserTemplates((prev) => prev.filter((item) => item.key !== key));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除模板失败" });
    }
  }

  // ── 导入：.md 标题/列表层级 → 树；.xmind 经库解析 → 树 ──────────────

  async function handleImportFiles(files: FileList): Promise<void> {
    const file = files[0];
    if (file === undefined) return;
    setImporting(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      let tree: import("../../lib/mindmap").MindMapNodeData | undefined;
      if (ext === "xmind") {
        tree = await xmindParser.parseXmindFile(file, false);
      } else if (ext === "md" || ext === "markdown") {
        tree = transformMarkdownTo(await file.text());
      } else {
        throw new Error("仅支持 .md / .markdown / .xmind 文件");
      }
      if (tree === undefined || tree.data === undefined) {
        throw new Error("文件内容解析不出导图结构");
      }
      const baseName = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "导入的导图";
      const meta = await createMindMap(baseName, "mindmap");
      await saveMindMap(meta.id, baseName, { root: tree });
      navigate(mindMapHash(meta.id));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导入失败" });
    } finally {
      setImporting(false);
    }
  }

  async function commitRename(): Promise<void> {
    const id = renamingId;
    if (id === null) return;
    setRenamingId(null);
    const title = renameDraft.trim();
    if (title === "") return;
    try {
      await renameMindMap(id, title);
      setMaps((prev) =>
        prev ? prev.map((row) => (row.id === id ? { ...row, title } : row)) : prev,
      );
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "重命名失败" });
    }
  }

  async function remove(row: MindMapMeta): Promise<void> {
    // 删除不可恢复（整张图的内容一并没了），先弹原生对话框确认；
    // window.confirm 在 Tauri WebView 下不可靠，统一走 dialog 插件。
    const isBoard = row.kind === "whiteboard";
    const confirmed = await confirm(
      isBoard
        ? `删除白板「${row.title}」？整块白板的内容会一并删除，不可恢复。`
        : `删除导图「${row.title}」？整张图的内容会一并删除，不可恢复。`,
      { title: isBoard ? "删除白板" : "删除导图", kind: "warning" },
    );
    if (!confirmed) return;
    try {
      await deleteMindMap(row.id);
      setMaps((prev) => (prev ? prev.filter((item) => item.id !== row.id) : prev));
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "删除失败" });
    }
  }

  const isBoard = kind === "whiteboard";
  const noun = isBoard ? "白板" : "导图";

  return (
    <>
      <section className="card">
        <h2 className="card__title">
          <span className="card__index">MM</span>知识导图
        </h2>
        <p className="hint-text">
          {isBoard
            ? "自由白板：图形、箭头、文字、画笔随手摆放，位置完全自由，改动自动保存到本地。"
            : "在画布上手绘知识结构：Enter 建同级、Tab 建子级、拖拽换父，改动自动保存到本地。"}
        </p>
        <div className="card__actions">
          <div className="mm-kind-tabs" role="tablist" aria-label="对象类型">
            {KIND_TABS.map((tab) => (
              <button
                key={tab.kind}
                type="button"
                role="tab"
                aria-selected={kind === tab.kind}
                className={kind === tab.kind ? "mm-kind-tab mm-kind-tab--active" : "mm-kind-tab"}
                onClick={() => setKind(tab.kind)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button button--primary"
            disabled={creating}
            onClick={handleCreateClick}
          >
            {creating ? "创建中…" : `新建${noun}`}
          </button>
          {kind === "mindmap" && (
            <button
              type="button"
              className="button"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
            >
              {importing ? "导入中…" : "导入 MD / XMind"}
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">{isBoard ? "✏️" : "🗂"}</span>
          我的{noun}
          <span className="hint-text" style={{ marginLeft: "auto", fontWeight: 400 }}>
            {maps !== null ? `${maps.length} ${isBoard ? "块" : "张"}` : ""}
          </span>
        </h2>
        {maps !== null && maps.length === 0 && (
          <p className="hint-text">还没有{noun}。点上面的「新建{noun}」开始{isBoard ? "画第一块" : "画第一张"}。</p>
        )}
        {maps !== null && maps.length > 0 && (
          <ul className="ws-docs">
            {maps.map((row) => (
              <li key={row.id} className="ws-doc">
                <div
                  className="ws-doc__head"
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate(mindMapHash(row.id))}
                  title="点开编辑"
                >
                  {renamingId === row.id ? (
                    <input
                      type="text"
                      className="cfg-input"
                      autoFocus
                      value={renameDraft}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRename();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => void commitRename()}
                    />
                  ) : (
                    <span className="ws-doc__title">{row.title}</span>
                  )}
                  <span className="ws-doc__page-meta">
                    {new Date(row.updatedAt * 1000).toLocaleString()}
                  </span>
                </div>
                <div className="ws-doc__page">
                  <span className="ws-doc__page-meta">点击编辑 · 自动保存</span>
                  <span className="ws-doc__page-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`重命名${noun}`}
                      title="重命名"
                      onClick={() => {
                        setRenamingId(row.id);
                        setRenameDraft(row.title);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`删除${noun}`}
                      title="删除"
                      onClick={() => void remove(row)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <input
        ref={importInputRef}
        type="file"
        accept=".md,.markdown,.xmind"
        style={{ display: "none" }}
        onChange={(event) => {
          const files = event.target.files;
          event.target.value = "";
          if (files !== null && files.length > 0) void handleImportFiles(files);
        }}
      />
      {templateDialogOpen && (
        <TemplateDialog
          builtin={BUILTIN_TEMPLATES as ReadonlyArray<MindMapTemplateDef>}
          userTemplates={userTemplates}
          onPick={(template) => void handlePickTemplate(template)}
          onDeleteUser={(key) => void handleDeleteUserTemplate(key)}
          onClose={() => setTemplateDialogOpen(false)}
        />
      )}
    </>
  );
}

export default MindMapView;
