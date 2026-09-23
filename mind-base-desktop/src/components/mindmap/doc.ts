/**
 * 知识导图文档与画布主题。
 *
 * 文档结构 = simple-mind-map `getData(true)` 的输出：
 *   { root: 节点树, layout, theme: { template, config }, view }
 * 画布主题走纯 config 定制（template 恒为 default）：纸墨单色基调 +
 * 可选连线强调色，浅/深两档由应用主题推导后整卡存进文档。
 */

import type { MindMapDoc } from "../../lib/mindmap";

/** 建新图 / 坏档兜底的默认文档。 */
export function defaultMindMapDoc(accentId: string, dark: boolean): MindMapDoc {
  return {
    root: { data: { text: "中心主题" }, children: [] },
    layout: "logicalStructure",
    theme: { config: buildThemeConfig(accentId, dark) },
  };
}

/**
 * 解析一份持久化文档 JSON；空串或坏档退回默认文档。
 * layout / theme.config 缺失时按当前应用主题补齐。
 */
export function parseMindMapDoc(raw: string, accentId: string, dark: boolean): MindMapDoc {
  const fallbackConfig = buildThemeConfig(accentId, dark);
  const fallback: MindMapDoc = {
    root: { data: { text: "中心主题" }, children: [] },
    layout: "logicalStructure",
    theme: { config: fallbackConfig },
  };
  if (raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<MindMapDoc>;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.root !== null &&
      typeof parsed.root === "object" &&
      typeof parsed.root.data === "object" &&
      parsed.root.data !== null
    ) {
      const doc = parsed as MindMapDoc;
      if (doc.layout === undefined || doc.layout === "") doc.layout = fallback.layout;
      if (doc.theme?.config === undefined) {
        doc.theme = { config: fallbackConfig };
      }
      return doc;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 画布布局候选（simple-mind-map 内置布局值）。 */
export const LAYOUTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "logicalStructure", label: "逻辑结构图" },
  { value: "mindMap", label: "思维导图" },
  { value: "organizationStructure", label: "组织结构图" },
  { value: "fishbone", label: "鱼骨图" },
  { value: "timeline", label: "时间线" },
];

/** 连线强调色（节点保持纸墨单色，只有连线上色——贴合应用的单色设计）。 */
export const LINE_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  light: string;
  dark: string;
}> = [
  { id: "ink", label: "墨", light: "#a8a8a3", dark: "#4a4a46" },
  { id: "indigo", label: "靛", light: "#4a6fa5", dark: "#7b97c9" },
  { id: "teal", label: "青", light: "#2e8b74", dark: "#6cc3a9" },
  { id: "clay", label: "赭", light: "#b0673f", dark: "#cf9873" },
];

/** 当前应用主题是否深色（lib/theme.ts 把解析结果写在 <html data-theme>）。 */
export function isAppDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

/** 组装画布主题配置：纸墨基调（浅/深）+ 连线强调色。 */
export function buildThemeConfig(accentId: string, dark: boolean): Record<string, unknown> {
  const accent = LINE_PRESETS.find((preset) => preset.id === accentId) ?? LINE_PRESETS[0];
  const font = '"Geist Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
  if (dark) {
    return {
      backgroundColor: "#212121",
      lineWidth: 1.2,
      lineColor: accent.dark,
      generalizationLineColor: accent.dark,
      root: {
        fillColor: "#2b2b2a",
        color: "#ececec",
        borderColor: "#a6a6a2",
        borderWidth: 2,
        fontFamily: font,
        fontSize: 16,
        fontWeight: "bold",
      },
      second: {
        fillColor: "#2b2b2a",
        color: "#ececec",
        borderColor: "#4d4d4a",
        borderWidth: 1,
        fontFamily: font,
      },
      node: {
        fillColor: "#2b2b2a",
        color: "#ececec",
        borderColor: "#3a3a38",
        borderWidth: 1,
        fontFamily: font,
      },
    };
  }
  return {
    backgroundColor: "#ffffff",
    lineWidth: 1.2,
    lineColor: accent.light,
    generalizationLineColor: accent.light,
    root: {
      // 默认白底 + 近黑描边（不再用黑底反色块，整体保持暖灰浅色基调）。
      fillColor: "#ffffff",
      color: "#0d0d0d",
      borderColor: "#0d0d0d",
      borderWidth: 2,
      fontFamily: font,
      fontSize: 16,
      fontWeight: "bold",
    },
    second: {
      fillColor: "#ffffff",
      color: "#0d0d0d",
      borderColor: "#d9d9d6",
      borderWidth: 1,
      fontFamily: font,
    },
    node: {
      fillColor: "#ffffff",
      color: "#0d0d0d",
      borderColor: "#ececeb",
      borderWidth: 1,
      fontFamily: font,
    },
  };
}
