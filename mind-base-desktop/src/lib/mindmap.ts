/**
 * Typed access to the mind map / whiteboard commands (`mindmap_*` on the Rust
 * side).
 *
 * 导图（simple-mind-map 树 JSON）与自由白板（Excalidraw 场景 JSON）共用同一
 * 张 mind_maps 表，靠 `kind` 列区分；保存整卡覆盖；导出文件落共享的 exports/
 * 目录，自动进入现有生成记录。
 */

import { invoke } from "@tauri-apps/api/core";

/** 对象类型：`mindmap`（simple-mind-map 树）或 `whiteboard`（Excalidraw 场景）。 */
export type MindObjectKind = "mindmap" | "whiteboard";

/** One node of the map tree (simple-mind-map node data shape). */
export interface MindMapNodeData {
  data: { text?: string; uid?: string; expand?: boolean } & Record<string, unknown>;
  children: MindMapNodeData[];
}

/** Full map document: node tree + layout + theme + view transform. */
export interface MindMapDoc {
  root: MindMapNodeData;
  layout?: string;
  theme?: { template?: string; config?: Record<string, unknown> };
  view?: unknown;
}

/** 白板文档：Excalidraw 场景（elements + 图片素材 files + 视图相关 appState 子集）。 */
export interface WhiteboardScene {
  type: "excalidraw";
  version: 1;
  elements: unknown[];
  /** 画布内插入的图片素材（Excalidraw BinaryFiles，键为文件 id）。 */
  files?: Record<string, unknown>;
  appState?: {
    viewBackgroundColor?: string;
    scrollX?: number;
    scrollY?: number;
    zoom?: { value: number };
  };
}

/** A mind map / whiteboard as listed in the library view. */
export interface MindMapMeta {
  id: string;
  title: string;
  kind: MindObjectKind;
  createdAt: number;
  updatedAt: number;
}

/** A mind map / whiteboard in full (editor load). */
export interface MindMapDetail extends MindMapMeta {
  /** Document JSON; empty while the editor has not saved yet. */
  data: string;
}

/** Create an empty object of the given kind and return its meta. */
export function createMindMap(title?: string, kind: MindObjectKind = "mindmap"): Promise<MindMapMeta> {
  return invoke<MindMapMeta>("mindmap_create", { title: title ?? null, kind });
}

/** List objects, most recently updated first; kind filters by type. */
export function listMindMaps(kind?: MindObjectKind): Promise<MindMapMeta[]> {
  return invoke<MindMapMeta[]>("mindmap_list", { kind: kind ?? null });
}

/** Load one map in full; null when the id is unknown. */
export function getMindMap(id: string): Promise<MindMapDetail | null> {
  return invoke<MindMapDetail | null>("mindmap_get", { id });
}

/** Overwrite title + document (editor autosave); returns the new updatedAt. */
export function saveMindMap(
  id: string,
  title: string,
  doc: MindMapDoc | WhiteboardScene,
): Promise<number> {
  return invoke<number>("mindmap_save", { id, title, data: JSON.stringify(doc) });
}

/** Rename without touching the document (library inline rename). */
export function renameMindMap(id: string, title: string): Promise<void> {
  return invoke<void>("mindmap_rename", { id, title });
}

/** Delete one map. */
export function deleteMindMap(id: string): Promise<void> {
  return invoke<void>("mindmap_delete", { id });
}

/** Save one export artifact (PNG/SVG/PDF/MD, base64) into the shared exports
 * dir; returns the absolute path. It then shows up in the existing 生成记录
 * view.
 */
export function saveMindMapExport(
  stem: string,
  ext: string,
  contentBase64: string,
): Promise<string> {
  return invoke<string>("mindmap_export_save", { stem, ext, contentBase64 });
}

// ── 图形包（右侧图形库的自定义分组，存 <数据目录>/mindmap-icons/） ────

/** 一个自定义图形（icon 为 svg 文本或 dataURL/URL）。 */
export interface MindMapIconPackItem {
  name: string;
  icon: string;
}

/** 用户导入的图形包。 */
export interface MindMapIconPack {
  key: string;
  name: string;
  items: MindMapIconPackItem[];
}

/** 列出全部图形包。 */
export function listMindMapIconPacks(): Promise<MindMapIconPack[]> {
  return invoke<MindMapIconPack[]>("mindmap_icon_pack_list");
}

/** 保存一个图形包（图形内容总量上限 8MB，由后端校验）。 */
export function saveMindMapIconPack(
  name: string,
  items: MindMapIconPackItem[],
): Promise<MindMapIconPack> {
  return invoke<MindMapIconPack>("mindmap_icon_pack_save", { name, items });
}

/** 删除一个图形包。 */
export function deleteMindMapIconPack(key: string): Promise<void> {
  return invoke<void>("mindmap_icon_pack_delete", { key });
}

// ── 版本历史（快照）：自动定时 + 手动"存一版"，保留最近 30 版 ────────

/** 一条快照记录（列表展示用，不含数据体）。 */
export interface MindMapSnapshotMeta {
  id: string;
  mapId: string;
  title: string;
  dataLen: number;
  createdAt: number;
}

/** 给当前内容拍一版快照；title 缺省记为「自动快照」。 */
export function createMindMapSnapshot(mapId: string, title?: string): Promise<MindMapSnapshotMeta> {
  return invoke<MindMapSnapshotMeta>("mindmap_snapshot_create", {
    mapId,
    title: title ?? null,
  });
}

/** 列出一张导图的全部快照（新→旧）。 */
export function listMindMapSnapshots(mapId: string): Promise<MindMapSnapshotMeta[]> {
  return invoke<MindMapSnapshotMeta[]>("mindmap_snapshot_list", { mapId });
}

/** 回滚到指定快照；回滚前当前内容会先被自动存为「回滚备份」。 */
export function restoreMindMapSnapshot(snapshotId: string): Promise<number> {
  return invoke<number>("mindmap_snapshot_restore", { snapshotId });
}

// ── 我的模板：把当前导图存成可复用骨架（存 <数据目录>/mindmap-templates/） ──

/** 一个用户模板（data 为整卡导图 JSON）。 */
export interface MindMapTemplate {
  key: string;
  name: string;
  data: string;
}

/** 保存一个用户模板。 */
export function saveMindMapTemplate(name: string, data: string): Promise<MindMapTemplate> {
  return invoke<MindMapTemplate>("mindmap_template_save", { name, data });
}

/** 列出全部用户模板。 */
export function listMindMapTemplates(): Promise<MindMapTemplate[]> {
  return invoke<MindMapTemplate[]>("mindmap_template_list");
}

/** 删除一个用户模板。 */
export function deleteMindMapTemplate(key: string): Promise<void> {
  return invoke<void>("mindmap_template_delete", { key });
}
