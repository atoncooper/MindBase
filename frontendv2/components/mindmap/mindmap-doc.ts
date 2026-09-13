/**
 * Mind map document types (simple-mind-map tree JSON).
 *
 * 与桌面端 mind-base-desktop/src/lib/mindmap.ts 的 MindMapDoc 保持同一形状，
 * 使两端的板文档可互通（web 端为主存储；桌面端未来改调同一 API）。
 */

/** simple-mind-map 节点数据形状。 */
export interface MindMapNodeData {
    data: { text?: string; uid?: string; expand?: boolean } & Record<string, unknown>;
    children: MindMapNodeData[];
}

/** 完整导图文档：节点树 + 布局 + 主题 + 视图变换。 */
export interface MindMapDoc {
    root: MindMapNodeData;
    layout?: string;
    theme?: { template?: string; config?: Record<string, unknown> };
    view?: unknown;
}

/** 解析板正文为导图文档；内容为空或形状不符时返回 null。 */
export function parseMindMapDoc(content: string | null): MindMapDoc | null {
    if (!content) return null;
    try {
        const doc = JSON.parse(content) as MindMapDoc;
        if (doc && typeof doc === "object" && doc.root && Array.isArray(doc.root.children)) {
            return doc;
        }
        return null;
    } catch {
        return null;
    }
}
