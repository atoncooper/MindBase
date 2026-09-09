/**
 * 导图 → 白板单向副本：把导图树转成 Excalidraw 场景（节点→带文字的
 * 矩形、父子线→箭头，按逻辑结构分层排布）。原图不动，白板里自由编辑。
 * 元素骨架经 Excalidraw 自带的 convertToExcalidrawElements 补全字段。
 */

import type { MindMapDoc, MindMapNodeData, WhiteboardScene } from "../../lib/mindmap";

/** 富文本 HTML → 纯文本（导图节点 text 可能带高亮标签）。 */
function toPlainText(text: string): string {
  if (!text.includes("<")) return text.replace(/\u200b/g, "");
  const div = document.createElement("div");
  div.innerHTML = text;
  return (div.textContent ?? "").replace(/\u200b/g, "").trim();
}

const COL_W = 320; // 层间距
const ROW_H = 72; // 叶节点行高（含间隙）

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function convertDocToWhiteboardScene(doc: MindMapDoc): Promise<WhiteboardScene> {
  const { convertToExcalidrawElements } = await import("./excalidrawBundle");
  const skeletons: unknown[] = [];
  let cursorY = 40;

  function shape(box: Box, text: string): void {
    skeletons.push({
      type: "rectangle",
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      label: { text, fontSize: 14, textAlign: "center", verticalAlign: "middle" },
    });
  }

  function arrow(from: Box, to: Box): void {
    skeletons.push({
      type: "arrow",
      x: from.x + from.w,
      y: from.y + from.h / 2,
      points: [[0, 0], [to.x - (from.x + from.w), to.y + to.h / 2 - (from.y + from.h / 2)]],
      strokeColor: "#696969",
    });
  }

  function walk(node: MindMapNodeData, depth: number): Box {
    const text = toPlainText(String(node.data?.text ?? "")) || " ";
    const firstLine = text.split("\n")[0] ?? "";
    const w = Math.min(280, Math.max(120, 56 + firstLine.length * 14));
    const h = Math.max(40, 24 + text.split("\n").length * 20);
    if (node.children.length === 0) {
      const box: Box = { x: depth * COL_W, y: cursorY, w, h };
      cursorY += ROW_H;
      shape(box, text);
      return box;
    }
    const childBoxes = node.children.map((child) => walk(child, depth + 1));
    const first = childBoxes[0];
    const last = childBoxes[childBoxes.length - 1];
    const box: Box = {
      x: depth * COL_W,
      y: (first.y + first.h / 2 + last.y + last.h / 2) / 2 - h / 2,
      w,
      h,
    };
    shape(box, text);
    childBoxes.forEach((child) => arrow(box, child));
    return box;
  }

  walk(doc.root, 0);
  const elements = convertToExcalidrawElements(skeletons as never) as unknown[];
  return {
    type: "excalidraw",
    version: 1,
    elements,
    appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  };
}
