"use client";

/**
 * 白板编辑器占位（P3 移植 Excalidraw）。
 *
 * MindMapEditorView 在 kind==='whiteboard' 时分发到这里；web 端 P2 只上思维
 * 导图，白板入口先给占位 UI。存储契约（board kind='whiteboard' + Excalidraw
 * scene JSON）已在 app-board 就绪，届时只换这个组件。
 */

export default function WhiteboardEditorView({ mapId }: { mapId: string }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-border-subtle">
            <p className="text-sm text-secondary">白板编辑器即将提供</p>
            <p className="text-xs text-tertiary">存储契约已就绪（board #{mapId.slice(0, 8)}…），P3 接入 Excalidraw</p>
        </div>
    );
}
