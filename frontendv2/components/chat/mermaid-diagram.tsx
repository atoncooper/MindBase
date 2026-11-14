"use client";

/**
 * Mermaid fenced-code-block renderer for the shared <Markdown> renderer.
 *
 * - The mermaid bundle is heavy and DOM-only, so it is imported lazily inside
 *   an effect (never during SSR) and cached in a module-level promise: every
 *   diagram on the page shares one chunk download + one initialize() call.
 * - Streaming assistant messages rewrite the code fence on almost every token,
 *   so rendering is debounced (250ms) and guarded by a monotonic token: a slow
 *   render that finishes after the code changed is dropped instead of painting
 *   a stale diagram.
 * - The theme is the app's light palette expressed as plain hex values. Mermaid
 *   inlines these into the SVG <style>, where CSS custom properties from
 *   globals.css would not resolve, so every value must stay a literal color.
 * - Parse/render failures degrade to a card with the original source, copy and
 *   retry. Nothing here ever throws into React.
 */

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, RotateCcw } from "lucide-react";
import type { MermaidConfig } from "mermaid";

type MermaidModule = typeof import("mermaid");
type MermaidApi = MermaidModule["default"];

// Theme variables mapped to the app's light tokens (globals.css): accent
// #0071e3, surface #ffffff, background #fbfbfd, foreground #1d1d1f, border
// #d2d2d7, secondary #86868b. Keep every value a literal color.
const MERMAID_THEME_VARIABLES = {
  background: "#fbfbfd",
  primaryColor: "#ffffff",
  primaryTextColor: "#1d1d1f",
  primaryBorderColor: "#d2d2d7",
  secondaryColor: "#ffffff",
  secondaryTextColor: "#86868b",
  secondaryBorderColor: "#d2d2d7",
  tertiaryColor: "#fbfbfd",
  tertiaryTextColor: "#1d1d1f",
  tertiaryBorderColor: "#d2d2d7",
  lineColor: "#86868b",
  textColor: "#1d1d1f",
  mainBkg: "#ffffff",
  nodeBorder: "#d2d2d7",
  nodeTextColor: "#1d1d1f",
  clusterBkg: "#fbfbfd",
  clusterBorder: "#d2d2d7",
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
  pie1: "#0071e3",
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
  const [copied, setCopied] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const reactId = useId();
  const idPrefixRef = useRef(`mbm-${reactId.replace(/[^A-Za-z0-9_-]/g, "") || "diagram"}`);
  const tokenRef = useRef(0);
  const attemptCodeRef = useRef<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

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

  return (
    <div className="md-code my-3 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] uppercase tracking-wide text-tertiary">
          {error ? (
            <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          )}
          Mermaid
          {pending && <span className="normal-case">· 渲染中…</span>}
          {error && <span className="normal-case">· 渲染失败</span>}
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
          <pre className="m-0 max-h-[24rem] overflow-auto bg-[#f5f5f7] px-3 py-2.5 text-[13px] leading-relaxed">
            <code className="font-mono text-foreground">{text}</code>
          </pre>
        </>
      ) : svg ? (
        <>
          <div className="overflow-auto bg-[#fbfbfd] px-3 py-3">
            {/* Mermaid sanitizes this markup itself (securityLevel "strict"
                runs DOMPurify before serializing the SVG), so injecting the
                returned string is safe. width="100%" plus an inline max-width
                cap from mermaid keeps the diagram responsive in the column. */}
            <div
              className="mx-auto flex justify-center [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
          {showSource && (
            <pre className="m-0 max-h-[24rem] overflow-auto border-t border-border/60 bg-[#f5f5f7] px-3 py-2.5 text-[13px] leading-relaxed">
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
  );
}
