"use client";

/**
 * Mermaid fenced-code-block renderer for the shared <Markdown> renderer.
 *
 * - The mermaid bundle is heavy and DOM-only, so it is imported lazily inside
 * an effect (never during SSR) and cached in a module-level promise: every
 * diagram on the page shares one chunk download + one initialize() call.
 * - Streaming assistant messages rewrite the code fence on almost every token,
 * so rendering is debounced (250ms) and guarded by a monotonic token: a slow
 * render that finishes after the code changed is dropped instead of painting
 * a stale diagram.
 * - The theme is the app's light palette expressed as plain hex values. Mermaid
 * inlines these into the SVG <style>, where CSS custom properties from
 * globals.css would not resolve, so every value must stay a literal color.
 * - Parse/render failures degrade to a card with the original source, copy and
 * retry. Nothing here ever throws into React.
 */

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, Maximize2, RotateCcw, X } from "lucide-react";
import type { MermaidConfig } from "mermaid";

type MermaidModule = typeof import("mermaid");
type MermaidApi = MermaidModule["default"];

// Theme variables mapped to the app's light tokens (globals.css): accent
// #0071e3, surface #ffffff, background #fbfbfd, foreground #1d1d1f, border
// #d2d2d7, secondary #86868b. Keep every value a literal color.
const MERMAID_THEME_VARIABLES = {
  background: "#fbfbfd",
  primaryColor: "#e8f1ff",
  primaryTextColor: "#1d1d1f",
  primaryBorderColor: "#0071e3",
  secondaryColor: "#fff4e5",
  secondaryTextColor: "#7a4a00",
  secondaryBorderColor: "#f5a623",
  tertiaryColor: "#e8f7ee",
  tertiaryTextColor: "#0b5d2a",
  tertiaryBorderColor: "#34c759",
  lineColor: "#86868b",
  textColor: "#1d1d1f",
  mainBkg: "#e8f1ff",
  nodeBorder: "#0071e3",
  nodeTextColor: "#1d1d1f",
  clusterBkg: "#f5f9ff",
  clusterBorder: "#9ec5ff",
  titleColor: "#1d1d1f",
  edgeLabelBackground: "#ffffff",
  // Sequence diagrams
  actorBkg: "#ffffff",
  actorBorder: "#d2d2d7",
  actorTextColor: "#1d1d1f",
  actorLineColor: "#86868b",
  signalColor: "#1d1d1f",
  signalTextColor: "#1d1d1f",
  labelBoxBkgColor: "#ffffff",
  labelBoxBorderColor: "#d2d2d7",
  labelTextColor: "#1d1d1f",
  loopTextColor: "#1d1d1f",
  noteBkgColor: "#fbfbfd",
  noteTextColor: "#1d1d1f",
  noteBorderColor: "#d2d2d7",
  activationBkgColor: "#ffffff",
  activationBorderColor: "#0071e3",
  sequenceNumberColor: "#1d1d1f",
  // Class / state / ER diagrams
  classText: "#1d1d1f",
  stateBkg: "#ffffff",
  stateBorder: "#d2d2d7",
  compositeBackground: "#fbfbfd",
  compositeBorder: "#d2d2d7",
  // Gantt / git / pie accents: one accent color, everything else neutral.
  todayLineColor: "#0071e3",
  taskBorderColor: "#d2d2d7",
  taskBkgColor: "#ffffff",
  taskTextColor: "#1d1d1f",
  sectionBkgColor: "#fbfbfd",
  altSectionBkgColor: "#ffffff",
  gridColor: "#d2d2d7",
  git0: "#0071e3",
  git1: "#f5a623",
  git2: "#34c759",
  git3: "#ff3b30",
  git4: "#af52de",
  pie1: "#0071e3",
  pie2: "#f5a623",
  pie3: "#34c759",
  pie4: "#ff3b30",
  pie5: "#af52de",
  pie6: "#5ac8fa",
};

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  // Mermaid's own error rendering appends a red "Syntax error" SVG to <body>;
  // the React card below is the only place errors should surface.
  suppressErrorRendering: true,
  theme: "base",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 14,
  themeVariables: MERMAID_THEME_VARIABLES,
};

const DEBOUNCE_MS = 250;

const ACTION_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

// One shared promise: the mermaid chunk + config are initialized exactly once
// per page, no matter how many diagrams are mounted.
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then((module) => {
        const mermaid = module.default;
        mermaid.initialize(MERMAID_CONFIG);
        return mermaid;
      })
      .catch((error: unknown) => {
        // Drop the rejected cache so retry (or the next diagram) can try again.
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

// mermaid.render() requires a unique id per call: it removes any previous DOM
// element carrying that id. A module counter plus the React useId prefix keeps
// ids unique across blocks and across re-renders of the same block.
let renderSequence = 0;
function nextRenderId(prefix: string): string {
  renderSequence += 1;
  return `${prefix}-${renderSequence}`;
}

// With suppressErrorRendering mermaid removes its own temporary nodes, but a
// render dropped as stale can still leave the wrapper behind; remove both known
// ids defensively. The rendered <svg id> only ever lives inside our container,
// never at document level, so removing these ids here cannot delete the card.
function removeMermaidArtifacts(id: string): void {
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(`i${id}`)?.remove();
}

type MermaidNodePalette = { fill: string; stroke: string; text: string };

/** Semantic palettes used when the generated diagram carries no explicit classDef/style. */
const NODE_PALETTES: Record<string, MermaidNodePalette> = {
  start: { fill: "#e8f1ff", stroke: "#0071e3", text: "#0b3d91" },
  decision: { fill: "#fff4e5", stroke: "#f5a623", text: "#7a4a00" },
  success: { fill: "#e8f7ee", stroke: "#34c759", text: "#0b5d2a" },
  danger: { fill: "#fdecea", stroke: "#ff3b30", text: "#8a1f18" },
  info: { fill: "#f5f5f7", stroke: "#8e8e93", text: "#1d1d1f" },
};

const ACTOR_PALETTES = [
  NODE_PALETTES.start,
  NODE_PALETTES.decision,
  NODE_PALETTES.success,
  NODE_PALETTES.danger,
];

/** Classify a node label by its role so flow/state/class diagrams get distinct colors. */
function classifyMermaidNode(label: string): MermaidNodePalette {
  const text = label.toLowerCase();
  if (/[?？]|是否|判断|决策|条件|分支|选择/.test(text)) return NODE_PALETTES.decision;
  if (/失败|错误|异常|拒绝|超时|告警|警告|未通过|缺少|风险/.test(text)) return NODE_PALETTES.danger;
  if (/完成|成功|通过|结果|输出|结束|返回|就绪|已确认/.test(text)) return NODE_PALETTES.success;
  if (/开始|入口|用户|请求|输入|触发|发起/.test(text)) return NODE_PALETTES.start;
  return NODE_PALETTES.info;
}

/** 模型未写 classDef/style 时，按节点语义自动上色；显式样式优先。 */
function colorizeMermaidDom(root: HTMLElement, source: string): void {
  if (/\bclassDef\b/.test(source) || /\bstyle\s+[A-Za-z0-9_]/.test(source)) return;
  const isSequence = /^\s*sequenceDiagram\b/m.test(source);
  const nodes = root.querySelectorAll("g.node, g.actor");
  nodes.forEach((node, index) => {
    const el = node as SVGGElement;
    const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const palette = isSequence ? ACTOR_PALETTES[index % ACTOR_PALETTES.length] : classifyMermaidNode(label);
    el.querySelectorAll("rect, polygon, circle, ellipse, path").forEach((shape) => {
      const element = shape as SVGElement;
      element.style.fill = palette.fill;
      element.style.stroke = palette.stroke;
      element.style.strokeWidth = "1.5";
    });
    el.querySelectorAll("text, tspan").forEach((text) => {
      (text as SVGElement).style.fill = palette.text;
    });
    el.querySelectorAll("foreignObject div").forEach((div) => {
      (div as HTMLElement).style.color = palette.text;
    });
  });
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
    const str = (error as { str?: unknown }).str;
    if (typeof str === "string" && str.trim()) return str;
  }
  return "图表渲染失败，请检查 Mermaid 语法。";
}

// Result of the last completed render, tagged with the exact source + retry
// attempt it belongs to. Any other state (new code, retry in flight, first
// mount) is derived as "pending", which keeps the effect free of synchronous
// setState calls (those trigger cascading renders and are lint-flagged).
type RenderResult =
  | { key: string; phase: "ready"; svg: string }
  | { key: string; phase: "error"; message: string };

function renderKeyOf(source: string, retryNonce: number): string {
  return `${source}\u0000${retryNonce}`;
}

export function MermaidDiagram({ code }: { code: string }) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const reactId = useId();
  const idPrefixRef = useRef(`mbm-${reactId.replace(/[^A-Za-z0-9_-]/g, "") || "diagram"}`);
  const tokenRef = useRef(0);
  const attemptCodeRef = useRef<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const diagramRef = useRef<HTMLDivElement | null>(null);

  // Drop the trailing newline react-markdown adds to the fence body; it only
  // shows up in the copied source otherwise.
  const text = code.replace(/\s+$/, "");
  const source = text.trim();
  const isEmpty = source.length === 0;
  const currentKey = renderKeyOf(source, retryNonce);
  const current = result && result.key === currentKey ? result : null;
  const pending = !isEmpty && current === null;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    // Invalidate any in-flight render as soon as the code (or retry) changes.
    tokenRef.current += 1;
    if (!source) {
      attemptCodeRef.current = null;
      return;
    }
    const token = tokenRef.current;
    const key = renderKeyOf(source, retryNonce);
    // Retry on unchanged source renders immediately; a changed fence waits for
    // the debounce so streaming updates do not queue one render per token.
    const delay = attemptCodeRef.current === source ? 0 : DEBOUNCE_MS;
    attemptCodeRef.current = source;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let renderId = "";
        try {
          const mermaid = await loadMermaid();
          if (cancelled || tokenRef.current !== token) return;
          renderId = nextRenderId(idPrefixRef.current);
          const { svg } = await mermaid.render(renderId, source);
          if (cancelled || tokenRef.current !== token) {
            removeMermaidArtifacts(renderId);
            return;
          }
          setResult({ key, phase: "ready", svg });
        } catch (error) {
          if (renderId) removeMermaidArtifacts(renderId);
          if (cancelled || tokenRef.current !== token) return;
          setResult({ key, phase: "error", message: toErrorMessage(error) });
        }
      })();
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, retryNonce]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
    /* clipboard may be unavailable (insecure context); ignore */
    }
  };

  const error = current?.phase === "error" ? current.message : null;
  const svg = current?.phase === "ready" ? current.svg : null;

  // After the fresh SVG is inserted, tint nodes when the model omitted classDef
  // (see colorizeMermaidDom). Runs per render result/source change only.
  useEffect(() => {
    if (!svg || !diagramRef.current) return;
    colorizeMermaidDom(diagramRef.current, source);
  }, [svg, source]);

  // Fullscreen viewer: lock page scroll and close with Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  return (
    <>
    <div className="my-4 overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-[0_1px_2px_rgba(60,64,67,0.05)]">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border-subtle bg-[#f5f5f7] px-4 py-2.5">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="flex min-w-0 items-center justify-center gap-1.5 truncate text-[11px] font-medium tracking-wide text-secondary">
          {error && <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />}
          Mermaid
          {pending && <span className="font-normal text-tertiary">· 渲染中…</span>}
          {error && <span className="font-normal text-tertiary">· 渲染失败</span>}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          {error && (
            <button
              type="button"
              onClick={() => setRetryNonce((value) => value + 1)}
              className={ACTION_BUTTON_CLASS}
              aria-label="重新渲染图表"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
          {svg && (
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className={ACTION_BUTTON_CLASS}
              aria-label="查看 Mermaid 图表大图"
            >
              <Maximize2 className="h-3 w-3" aria-hidden="true" />
              大图
            </button>
          )}
          {!isEmpty && !error && (
            <button
              type="button"
              onClick={() => setShowSource((value) => !value)}
              className={ACTION_BUTTON_CLASS}
              aria-expanded={showSource}
              aria-label={showSource ? "收起源码" : "查看源码"}
            >
              {showSource ? "收起源码" : "查看源码"}
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showSource ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            disabled={isEmpty}
            className={ACTION_BUTTON_CLASS}
            aria-label={copied ? "已复制" : "复制代码"}
          >
            {copied ? (
              <Check className="h-3 w-3 text-success" aria-hidden="true" />
            ) : (
              <Copy className="h-3 w-3" aria-hidden="true" />
            )}
            {copied ? "已复制" : "复制"}
          </button>
        </span>
      </div>

      {isEmpty ? (
        <div className="bg-[#fbfbfd] px-3 py-6 text-center text-[12px] text-tertiary">
          空的 Mermaid 代码块
        </div>
      ) : error ? (
        <>
          <div className="space-y-1 border-b border-border/60 px-3 py-2.5">
            <p className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-danger">
              {error}
            </p>
            <p className="m-0 text-[11px] text-tertiary">
              图表语法可能有误。可复制源码检查，或修正后重试。
            </p>
          </div>
          <pre className="m-0 max-h-[24rem] overflow-auto bg-[#f7f7f8] px-4 py-3 text-[13px] leading-relaxed">
            <code className="font-mono text-foreground">{text}</code>
          </pre>
        </>
      ) : svg ? (
        <>
          <div className="md-diagram-scroll bg-[#fbfbfd] px-5 py-5">
            {/* Mermaid sanitizes this markup itself (securityLevel "strict"
                runs DOMPurify before serializing the SVG), so injecting the
                returned string is safe. width="100%" plus an inline max-width
                cap from mermaid keeps the diagram responsive in the column. */}
            <div
              ref={diagramRef}
              className="mx-auto flex min-h-[120px] min-w-0 justify-center [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          {showSource && (
            <pre className="m-0 max-h-[24rem] overflow-auto border-t border-border-subtle bg-[#f7f7f8] px-4 py-3 text-[13px] leading-relaxed">
              <code className="font-mono text-foreground">{text}</code>
            </pre>
          )}
        </>
      ) : (
        <div
          className="flex min-h-40 items-center justify-center bg-[#fbfbfd] px-4 py-8"
          role="status"
          aria-live="polite"
        >
          <div className="w-full max-w-sm animate-pulse space-y-2" aria-hidden="true">
            <div className="mx-auto h-3 w-1/3 rounded bg-border-subtle" />
            <div className="mx-auto h-3 w-2/3 rounded bg-border-subtle" />
            <div className="h-24 rounded-lg bg-border-subtle" />
          </div>
          <span className="sr-only">正在渲染 Mermaid 图表…</span>
        </div>
      )}
    </div>
    {fullscreen && svg && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-3 backdrop-blur-[2px] sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="Mermaid 图表大图"
        onClick={() => setFullscreen(false)}
      >
        <div
          className="flex h-full max-h-[92vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl border border-white/20 bg-surface shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border-subtle bg-[#fbfbfd] px-4 py-3">
            <span className="text-[12px] font-medium text-foreground">Mermaid 图表</span>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="grid h-8 w-8 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
              aria-label="关闭大图"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div
            className="md-diagram-scroll h-full flex-1 bg-[#fbfbfd] p-6"
            style={{ maxHeight: "none" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    )}
    </>
  );
}
