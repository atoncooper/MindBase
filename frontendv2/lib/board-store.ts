/**
 * Board storage bridge — web 版的 `lib/mindmap.ts`（桌面端为 Tauri invoke）。
 *
 * 与桌面端完全同形的导出契约，编辑器组件零改动迁移：
 *   - 核心文档 CRUD  → boards API（app-board 服务，If-Match 乐观锁）
 *   - 导出文件       → 浏览器下载（桌面端写入"生成记录"目录）
 *   - 图形包/模板/快照 → localStorage（桌面端存数据目录；web 端为客户端本地）
 *
 * If-Match 语义：模块内缓存每块板的当前 version；PUT 冲突（409）时按桌面端
 * "最后写入胜出"的语义取回服务端最新版本号、以本地内容重试一次。
 */

import {
    boardsApi,
    BoardConflictError,
    type BoardDetail,
    type BoardKind,
    type BoardMeta,
} from "./api/boards";

export type MindObjectKind = BoardKind;

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

/** 白板文档：Excalidraw 场景（P3 白板编辑器使用）。 */
export interface WhiteboardScene {
    type: "excalidraw";
    version: 1;
    elements: unknown[];
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

function metaToMind(b: BoardMeta): MindMapMeta {
    return {
        id: b.uuid,
        title: b.title,
        kind: b.kind,
        createdAt: new Date(b.createdAt).getTime(),
        updatedAt: new Date(b.updatedAt).getTime(),
    };
}

function detailToMind(d: BoardDetail): MindMapDetail {
    return { ...metaToMind(d), data: d.content ?? "" };
}

// If-Match version cache: the editor saves whole-doc and does not carry the
// version itself, so the bridge owns the latest known version per board.
const versionCache = new Map<string, number>();

function rememberVersion(id: string, version: number): void {
    versionCache.set(id, version);
}

async function currentVersion(id: string): Promise<number> {
    const known = versionCache.get(id);
    if (known !== undefined) return known;
    const d = await boardsApi.get(id);
    rememberVersion(id, d.version);
    return d.version;
}

/** Create an empty object of the given kind and return its meta. */
export async function createMindMap(title?: string, kind: MindObjectKind = "mindmap"): Promise<MindMapMeta> {
    const meta = await boardsApi.create({ title: title ?? "未命名导图", kind });
    rememberVersion(meta.uuid, meta.version);
    return metaToMind(meta);
}

/** List objects, most recently updated first; kind filters by type. */
export async function listMindMaps(kind?: MindObjectKind): Promise<MindMapMeta[]> {
    const r = await boardsApi.list({ kind });
    return r.items.map(metaToMind);
}

/** Load one map in full; null when the id is unknown. */
export async function getMindMap(id: string): Promise<MindMapDetail | null> {
    try {
        const d = await boardsApi.get(id);
        rememberVersion(id, d.version);
        return detailToMind(d);
    } catch (e) {
        if (e instanceof Error && e.message.includes("not found")) return null;
        throw e;
    }
}

/**
 * Overwrite title + document (editor autosave); returns the new updatedAt.
 * Conflicts (another window saved meanwhile) resolve last-write-wins with a
 * single version-refresh retry, matching the desktop's single-editor model.
 */
export async function saveMindMap(
    id: string,
    title: string,
    doc: MindMapDoc | WhiteboardScene,
): Promise<number> {
    const content = JSON.stringify(doc);
    const doUpdate = async (version: number) =>
        boardsApi.update(id, { title, content }, version);
    try {
        const meta = await doUpdate(await currentVersion(id));
        rememberVersion(id, meta.version);
        return new Date(meta.updatedAt).getTime();
    } catch (e) {
        if (!(e instanceof BoardConflictError)) throw e;
        // 409: adopt the server's current version and overwrite with ours.
        const d = await boardsApi.get(id);
        const meta = await doUpdate(d.version);
        rememberVersion(id, meta.version);
        return new Date(meta.updatedAt).getTime();
    }
}

export async function renameMindMap(id: string, title: string): Promise<void> {
    const meta = await boardsApi.update(id, { title }, await currentVersion(id));
    rememberVersion(id, meta.version);
}

export async function deleteMindMap(id: string): Promise<void> {
    await boardsApi.remove(id);
    versionCache.delete(id);
}

// ── 导出：浏览器下载（桌面端写入"生成记录"目录，toast 文案兼容路径） ──

function base64ToBlob(contentBase64: string, mime: string): Blob {
    const bin = atob(contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

const EXPORT_MIME: Record<string, string> = {
    html: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    json: "application/json",
    xmind: "application/zip",
    opml: "text/x-opml",
    md: "text/markdown",
};

/** Export an artifact: triggers a browser download; returns the filename. */
export async function saveMindMapExport(
    stem: string,
    ext: string,
    contentBase64: string,
): Promise<string> {
    const safe = (stem || "导图").replace(/[\\/:*?"<>|]/g, "_");
    const filename = `${safe}.${ext}`;
    const blob = base64ToBlob(contentBase64, EXPORT_MIME[ext] ?? "application/octet-stream");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return filename;
}

// ── 图形包（localStorage；桌面端存数据目录） ─────────────────────────

export interface MindMapIconPackItem {
    name: string;
    icon: string;
}

export interface MindMapIconPack {
    key: string;
    name: string;
    items: MindMapIconPackItem[];
}

const ICON_PACKS_KEY = "mindbase:mindmap:icon-packs";

function readJsonLS<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

function writeJsonLS(key: string, value: unknown): void {
    localStorage.setItem(key, JSON.stringify(value));
}

export async function listMindMapIconPacks(): Promise<MindMapIconPack[]> {
    return readJsonLS<MindMapIconPack[]>(ICON_PACKS_KEY, []);
}

/**
 * Sanitize an imported icon before it is stored and later injected via
 * innerHTML (overlays render icon packs as raw SVG). Strip script execution
 * vectors: <script>, event-handler attributes and javascript: URLs. The pack
 * is client-local (self-XSS only today), but sanitizing at import time keeps
 * the stored data clean for whatever renders it later.
 */
function sanitizeIcon(icon: string): string {
    if (!icon.startsWith("<svg") && !icon.startsWith("<?xml")) return icon; // dataURL/URL
    return icon
        .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
        .replace(/(href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, '$1="#"');
}

export async function saveMindMapIconPack(
    name: string,
    items: MindMapIconPackItem[],
): Promise<MindMapIconPack> {
    const packs = await listMindMapIconPacks();
    const pack: MindMapIconPack = {
        key: `pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        items: items.map((it) => ({ name: it.name, icon: sanitizeIcon(it.icon) })),
    };
    packs.push(pack);
    writeJsonLS(ICON_PACKS_KEY, packs);
    return pack;
}

export async function deleteMindMapIconPack(key: string): Promise<void> {
    const packs = (await listMindMapIconPacks()).filter((p) => p.key !== key);
    writeJsonLS(ICON_PACKS_KEY, packs);
}

// ── 版本历史（快照）：localStorage 按板存放，保留最近 30 版 ──────────

export interface MindMapSnapshotMeta {
    id: string;
    mapId: string;
    title: string;
    dataLen: number;
    createdAt: number;
}

interface SnapshotStore {
    [mapId: string]: Array<MindMapSnapshotMeta & { data: string }>;
}

const SNAPSHOTS_KEY = "mindbase:mindmap:snapshots";
const SNAPSHOT_LIMIT = 30;

function readSnapshots(): SnapshotStore {
    return readJsonLS<SnapshotStore>(SNAPSHOTS_KEY, {});
}

function writeSnapshots(store: SnapshotStore): void {
    try {
        writeJsonLS(SNAPSHOTS_KEY, store);
    } catch (e) {
        // localStorage (~5MB) full: drop the oldest snapshots across all maps
        // (keep the newest half of each list) and retry once.
        if (!(e instanceof DOMException) && !(e instanceof Error)) throw e;
        for (const mapId of Object.keys(store)) {
            const list = store[mapId];
            if (list.length > SNAPSHOT_LIMIT / 2) {
                store[mapId] = list.slice(0, Math.floor(SNAPSHOT_LIMIT / 2));
            }
        }
        writeJsonLS(SNAPSHOTS_KEY, store);
    }
}

/** 给当前内容拍一版快照；title 缺省记为「自动快照」。 */
export async function createMindMapSnapshot(mapId: string, title?: string): Promise<MindMapSnapshotMeta> {
    const d = await getMindMap(mapId);
    if (d === null) throw new Error("导图不存在，无法快照");
    const store = readSnapshots();
    const list = store[mapId] ?? [];
    const meta: MindMapSnapshotMeta & { data: string } = {
        id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mapId,
        title: title ?? "自动快照",
        dataLen: d.data.length,
        createdAt: Date.now(),
        data: d.data,
    };
    list.unshift(meta);
    store[mapId] = list.slice(0, SNAPSHOT_LIMIT);
    writeSnapshots(store);
    const { data: _data, ...rest } = meta;
    return rest;
}

/** 列出一张导图的全部快照（新→旧）。 */
export async function listMindMapSnapshots(mapId: string): Promise<MindMapSnapshotMeta[]> {
    const list = readSnapshots()[mapId] ?? [];
    return list.map(({ data: _data, ...rest }) => rest);
}

/** 回滚到指定快照；回滚前当前内容会先被自动存为「回滚备份」。 */
export async function restoreMindMapSnapshot(snapshotId: string): Promise<number> {
    const store = readSnapshots();
    for (const [mapId, list] of Object.entries(store)) {
        const idx = list.findIndex((s) => s.id === snapshotId);
        if (idx < 0) continue;
        const snap = list[idx];
        // 回滚备份（与桌面端语义一致），再写回快照内容。
        await createMindMapSnapshot(mapId, "回滚备份");
        const doc = JSON.parse(snap.data) as MindMapDoc | WhiteboardScene;
        const updatedAt = await saveMindMap(mapId, snap.title, doc);
        return updatedAt;
    }
    throw new Error("快照不存在");
}

// ── 我的模板（localStorage） ─────────────────────────────────────────

export interface MindMapTemplate {
    key: string;
    name: string;
    data: string;
}

const TEMPLATES_KEY = "mindbase:mindmap:templates";

export async function saveMindMapTemplate(name: string, data: string): Promise<MindMapTemplate> {
    const list = readJsonLS<MindMapTemplate[]>(TEMPLATES_KEY, []);
    const tpl: MindMapTemplate = {
        key: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        data,
    };
    list.push(tpl);
    writeJsonLS(TEMPLATES_KEY, list);
    return tpl;
}

export async function listMindMapTemplates(): Promise<MindMapTemplate[]> {
    return readJsonLS<MindMapTemplate[]>(TEMPLATES_KEY, []);
}

export async function deleteMindMapTemplate(key: string): Promise<void> {
    const list = (await listMindMapTemplates()).filter((t) => t.key !== key);
    writeJsonLS(TEMPLATES_KEY, list);
}
