"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, RefreshCw, ScrollText } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { sessionSummaryApi } from "@/lib/api";

interface SummaryModalProps {
  open: boolean;
  onClose: () => void;
  chatSessionId: string | null;
}

type SummaryStatus = "streaming" | "done" | "error";

/**
 * Session-summary dialog: streams a fresh detailed summary of the current
 * chat session (summary agent, POST /chat/sessions/{id}/summary SSE) and
 * renders it with the shared Markdown component. Copy / regenerate actions;
 * never writes into the conversation itself. Apple-alert styling mirrors
 * ConfirmDialog, widened to a reading layout.
 */
export function SummaryModal({ open, onClose, chatSessionId }: SummaryModalProps) {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<SummaryStatus>("streaming");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const startStream = useCallback(() => {
    if (!chatSessionId) return;
    let cancelled = false;
    setContent("");
    setError(null);
    setStatus("streaming");
    setCopied(false);

    (async () => {
      let accumulated = "";
      let settled = false; // done/error callback fired
      await sessionSummaryApi.streamSummary(
        chatSessionId,
        {
          onChunk: (delta) => {
            if (cancelled) return;
            accumulated += delta;
            setContent(accumulated);
          },
          onDone: () => {
            settled = true;
            if (!cancelled) setStatus("done");
          },
          onError: (msg) => {
            settled = true;
            if (cancelled) return;
            setError(msg);
            setStatus("error");
          },
        },
      );
      // Stream ended without done/error (e.g. connection dropped mid-way).
      if (!cancelled && !settled && accumulated) setStatus("done");
    })();

    return () => {
      cancelled = true;
    };
  }, [chatSessionId]);

  // Start a fresh summary each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const cancel = startStream();
    return cancel;
  }, [open, startStream]);

  // Escape to close (disabled mid-stream to avoid losing the generation).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && status !== "streaming") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, status, onClose]);

  // Keep the latest streamed content in view.
  useEffect(() => {
    if (status === "streaming" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, status]);

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={status === "streaming" ? undefined : onClose}
          />

          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
            className="relative flex max-h-[80vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]"
            role="dialog"
            aria-modal="true"
            aria-label="会话总结"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle px-5 py-3.5">
              <div className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-accent">
                <ScrollText className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                  会话总结
                </h2>
                <p className="truncate text-[12px] text-secondary">
                  {status === "streaming"
                    ? "正在总结当前会话…"
                    : status === "done"
                      ? "已生成并保存，未来可作为出题素材"
                      : "总结生成失败"}
                </p>
              </div>
            </div>

            {/* Body */}
            <div ref={scrollRef} className="min-h-[160px] flex-1 overflow-y-auto px-5 py-4">
              {status === "error" ? (
                <div className="py-4 text-center">
                  <p className="text-[14px] font-medium text-danger">生成失败</p>
                  <p className="mt-1 text-[13px] text-secondary">{error ?? "未知错误"}</p>
                </div>
              ) : content ? (
                status === "streaming" ? (
                  // Plain text while streaming (same perf note as chat-message).
                  <div className="md-body whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
                    {content}
                  </div>
                ) : (
                  <Markdown>{content}</Markdown>
                )
              ) : (
                <div
                  className="flex items-center justify-center gap-1.5 py-10"
                  role="status"
                  aria-label="正在生成总结"
                >
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-tertiary [animation-delay:300ms]" />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
              {status === "done" && (
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!content}
                  className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-secondary transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "已复制" : "复制"}
                </button>
              )}
              {status !== "streaming" && (
                <button
                  type="button"
                  onClick={startStream}
                  className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-accent transition-colors hover:bg-accent-soft"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重新生成
                </button>
              )}
              {status === "streaming" ? (
                <span className="text-[12px] text-tertiary">生成中，请稍候…</span>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-secondary transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  关闭
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
