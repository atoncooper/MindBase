"use client";

import { useState, useEffect, useRef, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown,
  ExternalLink,
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  AlertCircle,
  Sparkles,
} from "lucide-react";

interface Source {
  title: string;
  url?: string;
  bvid?: string;
}

interface ReasoningStep {
  step: number;
  action: string;
  query?: string;
  reasoning?: string;
  verdict?: string;
  recall_score?: number;
  sources: Source[];
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: Source[] | null;
  reasoningSteps?: ReasoningStep[] | null;
  agent?: string;
  status?: "pending" | "completed" | "failed";
  error?: string;
  timestamp?: string;
}

// Extract a readable domain from a source URL for the citation card.
function domainOf(url?: string): string {
  if (!url) return "bilibili.com";
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function ChatMessage({
  role,
  content,
  sources,
  reasoningSteps,
  agent,
  status = "completed",
  error,
}: ChatMessageProps) {
  // Normalize null/undefined → [] so .length and .map are always safe.
  const safeSources = Array.isArray(sources) ? sources : [];
  const safeReasoningSteps = Array.isArray(reasoningSteps) ? reasoningSteps : [];

  const [showReasoning, setShowReasoning] = useState(false);
  // Track manual toggle so auto-expand doesn't override the user's choice:
  // while streaming (pending) with steps arriving, auto-expand; once the
  // user toggles, respect their state.
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (!userToggledRef.current && safeReasoningSteps.length > 0 && status === "pending") {
      setShowReasoning(true);
    }
  }, [safeReasoningSteps.length, status]);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isUser = role === "user";
  const isPending = status === "pending";
  const isFailed = status === "failed";
  const showActions = !isUser && status === "completed" && !!content;

  // ---- User message: right-aligned compact pill ----
  if (isUser) {
    return (
      <div className="msg-row msg-row-user" role="article" aria-roledescription="用户消息">
        <div className="msg-user-pill">{content}</div>
      </div>
    );
  }

  // ---- Assistant message: full-width, no bubble, avatar-led ----
  return (
    <div
      className="msg-row msg-row-assistant"
      role="article"
      aria-roledescription="助手消息"
      aria-live={isPending ? "polite" : "off"}
    >
      <div className="msg-assistant-avatar" aria-hidden="true">
        <Sparkles className="w-4 h-4" />
      </div>

      <div className="msg-assistant-body">
        {/* Route badge - which agent handled this turn */}
        {agent && (
          <div className="msg-route-badge" aria-label={`路由到 ${agent} agent`}>
            <Sparkles className="w-3 h-3" aria-hidden="true" />
            <span>经由 {agent} agent</span>
          </div>
        )}
        {/* Reasoning toggle — Gemini style chip, above content */}
        {safeReasoningSteps.length > 0 && (
          <button
            type="button"
            onClick={() => {
              userToggledRef.current = true;
              setShowReasoning((v) => !v);
            }}
            className="msg-reasoning-toggle"
            aria-expanded={showReasoning}
            aria-controls="reasoning-content"
          >
            <ChevronDown
              className={`msg-reasoning-chevron ${showReasoning ? "is-open" : ""}`}
              aria-hidden="true"
            />
            <span>{showReasoning ? "收起思考过程" : `展示思考过程 · ${safeReasoningSteps.length} 步`}</span>
          </button>
        )}

        {showReasoning && (
          <div
            id="reasoning-content"
            className="msg-reasoning-content"
            role="region"
            aria-label="思考过程详情"
          >
            {safeReasoningSteps.map((step, i) => {
              const stepSources = Array.isArray(step.sources) ? step.sources : [];
              return (
                <div key={i} className="msg-reasoning-step">
                  <div className="msg-reasoning-step-head">
                    <span className="msg-reasoning-step-num">{String(step.step).padStart(2, "0")}</span>
                    <span className="msg-reasoning-step-action">{step.action}</span>
                  </div>
                  {step.query && (
                    <div className="msg-reasoning-step-line">
                      <span className="msg-reasoning-step-kicker">检索</span>
                      <code>{step.query}</code>
                    </div>
                  )}
                  {step.reasoning && (
                    <div className="msg-reasoning-step-line">{step.reasoning}</div>
                  )}
                  {step.verdict && (
                    <div
                      className={`msg-reasoning-verdict ${
                        step.verdict === "sufficient" ? "is-ok" : "is-warn"
                      }`}
                    >
                      结论：{step.verdict}
                      {step.recall_score != null && (
                        <span className="msg-reasoning-recall">
                          召回 {step.recall_score.toFixed(3)}
                        </span>
                      )}
                    </div>
                  )}
                  {stepSources.length > 0 && (
                    <div className="msg-reasoning-step-sources">
                      {stepSources.map((src, j) => (
                        <a
                          key={j}
                          href={src.url || `https://www.bilibili.com/video/${src.bvid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="msg-source-mini"
                        >
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                          <span>{src.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Content / loading / error */}
        <div className={`msg-assistant-content ${isFailed ? "is-failed" : ""}`}>
          {isPending && !content ? (
            <div className="msg-loading" role="status" aria-label="助手思考中">
              <span className="msg-loading-dot" style={{ animationDelay: "0ms" }} />
              <span className="msg-loading-dot" style={{ animationDelay: "180ms" }} />
              <span className="msg-loading-dot" style={{ animationDelay: "360ms" }} />
            </div>
          ) : isPending ? (
            // Streaming: render plain text to avoid re-parsing markdown on
            // every token (the main cause of janky/non-incremental rendering).
            <div className="markdown gemini-markdown">{content}</div>
          ) : (
            <ReactMarkdown className="markdown gemini-markdown" remarkPlugins={[remarkGfm]}>
              {content || ""}
            </ReactMarkdown>
          )}

          {isFailed && error && (
            <div className="msg-error">
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="msg-error-title">生成失败</div>
                <div className="msg-error-detail">{error}</div>
              </div>
            </div>
          )}
        </div>

        {/* Sources — citation cards, not pills */}
        {safeSources.length > 0 && (
          <div className="msg-sources">
            <div className="msg-sources-label">引用来源</div>
            <div className="msg-sources-grid">
              {safeSources.slice(0, 6).map((source, i) => {
                const domain = domainOf(source.url);
                return (
                  <a
                    key={i}
                    href={source.url || `https://www.bilibili.com/video/${source.bvid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="msg-source-card"
                  >
                    <span className="msg-source-card-index">{i + 1}</span>
                    <span className="msg-source-card-body">
                      <span className="msg-source-card-title">{source.title}</span>
                      <span className="msg-source-card-domain">
                        <span className="msg-source-card-favicon" aria-hidden="true">
                          {domain.charAt(0).toUpperCase()}
                        </span>
                        {domain}
                      </span>
                    </span>
                    <ExternalLink className="msg-source-card-arrow" aria-hidden="true" />
                  </a>
                );
              })}
              {safeSources.length > 6 && (
                <div className="msg-source-more">+{safeSources.length - 6} 个来源</div>
              )}
            </div>
          </div>
        )}

        {/* Action bar — ghost icon buttons, reveal on row hover */}
        {showActions && (
          <div className="msg-actions" role="group" aria-label="消息操作">
            <button
              type="button"
              onClick={handleCopy}
              className="msg-action-btn"
              aria-label={copied ? "已复制" : "复制消息"}
              aria-live="polite"
            >
              {copied ? (
                <Check className="w-4 h-4 msg-action-icon-ok" aria-hidden="true" />
              ) : (
                <Copy className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setFeedback(feedback === "up" ? null : "up")}
              className={`msg-action-btn ${feedback === "up" ? "is-active" : ""}`}
              aria-label="有帮助"
              aria-pressed={feedback === "up"}
            >
              <ThumbsUp className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setFeedback(feedback === "down" ? null : "down")}
              className={`msg-action-btn ${feedback === "down" ? "is-active" : ""}`}
              aria-label="无帮助"
              aria-pressed={feedback === "down"}
            >
              <ThumbsDown className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" className="msg-action-btn" aria-label="重新生成">
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessage);
