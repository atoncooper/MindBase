/**
 * simple-mind-map 的最小手写声明。
 *
 * npm 包在 package.json 里指向 ./types/index.d.ts，但该目录并未随包发布，
 * strict tsc 直接报错，只能自己兜底。这里只声明本项目用到的 API 面；
 * 需要新用法时在此扩展，不要试图完整手写库的全部类型。
 */

declare module "simple-mind-map" {
  export interface MindMapNodeData {
    data: { text?: string; uid?: string; expand?: boolean } & Record<string, unknown>;
    children: MindMapNodeData[];
  }

  /** 渲染树上的节点实例（renderer.activeNodeList 的成员）。 */
  export interface MindMapNodeInstance {
    isRoot?: boolean;
    isGeneralization?: boolean;
    /** 无 key 返回整份节点 data；有 key 返回对应字段（样式覆盖也存这里）。 */
    getData<T = unknown>(key?: string): T;
    /** 激活该节点（加入选中集合并高亮）。 */
    active(): void;
    /** 布局树上的父节点实例（根节点为 undefined）。 */
    parent?: MindMapNodeInstance;
    /** 布局层级：根为 0，二级为 1，以此类推。 */
    layerIndex?: number;
    /** 自定义文本换行宽度（拖拽调宽写入此字段）。 */
    customTextWidth?: number;
    /** 合并写入节点 data（样式覆盖 / customLeft 等），需再触发渲染。 */
    setData(data: Record<string, unknown>): void;
    /** 节点局部重渲染（如宽度拖拽时只重排文本）。 */
    reRender(changedTypes?: string[], options?: Record<string, unknown>): void;
    /** 节点根 SVG 分组；rbox() 返回视口坐标下的包围盒。 */
    group: {
      rbox(): { x: number; y: number; width: number; height: number };
    };
  }

  /** getData(true) 的输出，也是持久化文档的结构。 */
  export interface MindMapFullData {
    root: MindMapNodeData;
    layout?: string;
    theme?: { template?: string; config?: Record<string, unknown> };
    view?: unknown;
  }

  export interface MindMapOptions {
    el: HTMLElement;
    data: MindMapNodeData;
    layout?: string;
    theme?: string;
    fit?: boolean;
    mousewheelAction?: string;
    enableShortcutOnlyWhenMouseInSvg?: boolean;
    /** 节点可选图标（内置节点标记库在 src/svg/icons.js 的 nodeIconList）。 */
    iconList?: unknown[];
    [key: string]: unknown;
  }

  export default class MindMap {
    constructor(options: MindMapOptions);
    on(event: string, fn: (...args: any[]) => void): void;
    off(event: string, fn: (...args: any[]) => void): void;
    execCommand(...args: unknown[]): void;
    getData(withConfig: true): MindMapFullData;
    getData(withConfig?: false): MindMapNodeData;
    getData(withConfig?: boolean): MindMapFullData | MindMapNodeData;
    setLayout(layout: string): void;
    setThemeConfig(config: Record<string, unknown>): void;
    /** 需注册 Export 插件；isDownload=false 时返回数据（PNG 为 dataURL，SVG/MD 为文本）。 */
    export(type: string, isDownload: boolean, name?: string, ...args: unknown[]): Promise<unknown>;
    resize(): void;
    /** 重新渲染整棵树（节点 data 直写后调用）。 */
    render(): void;
    /** 按当前数据/配置重新渲染（图标注入等运行时变更后调用）。 */
    reRender(): void;
    /** 运行时选项（iconList 注入、插件配置等）。 */
    opt: { iconList?: unknown[]; [key: string]: unknown };
    /** 渲染器：选中节点集合与剪贴板操作（copy/cut/paste 已绑 Ctrl+C/X/V）。 */
    renderer: {
      /** 布局树根节点实例（双击空白新建节点时挂载目标）。 */
      root?: MindMapNodeInstance;
      activeNodeList: MindMapNodeInstance[];
      copy(): void;
      cut(): void;
      paste(): void;
      /** uid → 节点实例；找不到返回 null。 */
      findNodeByUid(uid: string): MindMapNodeInstance | null;
      /** 把节点移到画布中心。 */
      moveNodeToCenter(node: MindMapNodeInstance, resetScale?: boolean): void;
    };
    /** 需注册 AssociativeLine 插件；调用后进入连线模式，点击目标节点完成。 */
    /** 全局快捷键控制：对话框打开时 pause，关闭时 recovery（注意 restore 是另一对 save/restore 的缓存交换，勿混用）。 */
    keyCommand: { pause(): void; recovery(): void; restore(): void };
    associativeLine: {
      createLineFromActiveNode(): void;
      /** 当前激活的关联线 [path, clickPath, text, fromNode, toNode, marker]，未选中为 null。 */
      activeLine?: unknown[] | null;
      /** 删除当前激活的关联线。 */
      removeLine(): void;
    };
    /** 需注册 RainbowLines 插件；运行时切换连线彩虹配色。 */
    rainbowLines: {
      updateRainLinesConfig(config: { open: boolean; colorsList?: string[] }): void;
    };
    view: {
      fit(): void;
      translateXY(x: number, y: number): void;
      /** 当前变换状态（transform 为 SVG.js 矩阵，含 scaleX/translateX 等）。 */
      getTransformData(): {
        transform: { scaleX: number; scaleY: number; translateX: number; translateY: number };
        state: { scale: number; x: number; y: number };
      };
    };
    /** 布局树绘制组（rbox 取内容包围盒，屏幕坐标）。 */
    draw: { rbox(): { x: number; y: number; width: number; height: number } };
    /** 画布容器元素（尺寸/坐标换算用）。 */
    el: HTMLElement;
    /** 导出 SVG 的结构化数据（rect 为整图包围盒，页面坐标）。 */
    getSvgData(options?: Record<string, unknown>): {
      rect: { x: number; y: number; width: number; height: number; ratio: number };
      origWidth: number;
      origHeight: number;
      scaleX: number;
      scaleY: number;
      [key: string]: unknown;
    };
    /** 需注册 MiniMap 插件：计算小地图渲染数据与视口框位置。 */
    miniMap: {
      calculationMiniMap(boxWidth: number, boxHeight: number): {
        svgHTML: string;
        viewBoxStyle: Record<string, string>;
        miniMapBoxScale: number;
        miniMapBoxLeft: number;
        miniMapBoxTop: number;
      };
    };
    /** 需注册 Search 插件；search 传相同文本 = 跳到下一个匹配。 */
    search: {
      search(text: string, callback?: () => void): void;
      replace(replaceText: string, jumpNext?: boolean): void;
      replaceAll(replaceText: string): void;
      endSearch(): void;
    };
    /** 需注册 ExportXMind 插件：导图数据 + 名称 → .xmind zip Blob。 */
    doExportXMind: {
      xmind(data: MindMapFullData, name: string): Promise<Blob>;
    };
    destroy(): void;
    static usePlugin(plugin: unknown, options?: Record<string, unknown>): unknown;
  }
}

declare module "simple-mind-map/src/plugins/Export.js" {
  const Export: object;
  export default Export;
}

declare module "simple-mind-map/src/plugins/ExportPDF.js" {
  const ExportPDF: object;
  export default ExportPDF;
}

declare module "simple-mind-map/src/plugins/OuterFrame.js" {
  const OuterFrame: object;
  export default OuterFrame;
}

declare module "simple-mind-map/src/plugins/AssociativeLine.js" {
  const AssociativeLine: object;
  export default AssociativeLine;
}

declare module "simple-mind-map/src/plugins/Select.js" {
  const Select: object;
  export default Select;
}

declare module "simple-mind-map/src/plugins/RichText.js" {
  const RichText: object;
  export default RichText;
}

declare module "simple-mind-map/src/plugins/Formula.js" {
  const Formula: object;
  export default Formula;
}

/** Vite 的 ?raw 导入（文本资源原样内联）。 */
declare module "*?raw" {
  const source: string;
  export default source;
}

/** Prism.js 代码高亮（仅声明本项目用到的面）。 */
declare module "prismjs" {
  const Prism: {
    highlight(text: string, grammar: unknown, language: string): string;
    languages: Record<string, unknown>;
  };
  export default Prism;
}

/** 语言组件为副作用导入（向全局 Prism 注册语法）。 */
declare module "prismjs/components/*";

/** 内置节点标记图标库（优先级 / 旗标 / 进度等分组）。 */
declare module "simple-mind-map/src/svg/icons.js" {
  export interface MindMapIconItem {
    name: string;
    icon: string;
  }
  export interface MindMapIconGroup {
    name: string;
    type: string;
    list: MindMapIconItem[];
  }
  export const nodeIconList: MindMapIconGroup[];
}

declare module "simple-mind-map/src/plugins/Drag.js" {
  const Drag: object;
  export default Drag;
}

declare module "simple-mind-map/src/plugins/ExportXMind.js" {
  const ExportXMind: object;
  export default ExportXMind;
}

declare module "simple-mind-map/src/plugins/Search.js" {
  const Search: object;
  export default Search;
}

declare module "simple-mind-map/src/plugins/MiniMap.js" {
  const MiniMap: object;
  export default MiniMap;
}

declare module "simple-mind-map/src/parse/markdownTo.js" {
  /** Markdown（标题/列表层级）→ 导图节点树；取首个顶层节点为根。 */
  export function transformMarkdownTo(markdown: string): MindMapNodeData | undefined;
}

declare module "simple-mind-map/src/parse/xmind.js" {
  /** 解析 .xmind 文件（zip 内 content.json / content.xml）为导图节点树。 */
  export function parseXmindFile(file: File | Blob, handleMultiCanvas?: boolean): Promise<MindMapNodeData>;
  const xmindParser: {
    parseXmindFile: typeof parseXmindFile;
    transformXmind: unknown;
    transformOldXmind: unknown;
    transformToXmind: unknown;
  };
  export default xmindParser;
}
