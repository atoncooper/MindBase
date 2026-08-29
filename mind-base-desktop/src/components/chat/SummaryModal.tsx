/**
 * 会话总结弹窗 —— summary agent 的展示面。
 *
 * 打开时对指定会话发起流式总结（chunk 逐段追加），完成后可一键
 * 「保存为笔记」（走本地笔记 API，标题取会话名）。错误态保留已生成
 * 内容并给出重试入口。
 */

import { useEffect, useRef, useState } from "react";
import { getSavedSummary, summarizeSession, type ChatEvent } from "../../lib/chat";
import { createNote, saveNote } from "../../lib/notes";
import { toErrorMessage } from "../../lib/updater";
import { MarkdownContent } from "./MarkdownContent";

type SummaryState = "loading" | "streaming" | "done" | "error";

interface SummaryModalProps {
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
}

function SummaryModal({ sessionId, sessionTitle, onClose }: SummaryModalProps): React.JSX.Element {
  const [summary, setSummary] = useState("");
  const [phase, setPhase] = useState<SummaryState>("loading");
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // 上次生成时间（epoch 秒）；null = 本地没有持久化总结。
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const runIdRef = useRef(0);

  function run(): void {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setSummary("");
    setError("");
    setPhase("streaming");
    summarizeSession(sessionId, (event: ChatEvent) => {
      if (runIdRef.current !== runId) return; // 已重试/关闭，丢弃旧流
      if (event.type === "chunk") setSummary((prev) => prev + event.content);
      if (event.type === "done") {
        setSavedAt(Math.floor(Date.now() / 1000));
        setPhase("done");
      }
      if (event.type === "error") {
        setError(event.message);
        setPhase("error");
      }
    }).catch((err) => {
      if (runIdRef.current !== runId) return;
      setError(toErrorMessage(err));
      setPhase("error");
    });
  }

  // 打开时先取本地持久化的上次总结——有则秒开回看，无则现场生成。
  useEffect(() => {
    let cancelled = false;
    getSavedSummary(sessionId).then(
      (saved) => {
        if (cancelled) return;
        if (saved !== null && saved.content.trim() !== "") {
          setSummary(saved.content);
          setSavedAt(saved.createdAt);
          setPhase("done");
        } else {
          run();
        }
      },
      () => {
        if (!cancelled) run(); // 读取失败不阻塞，直接走生成
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 打开/切换会话时执行一次
  }, [sessionId]);

  async function saveAsNote(): Promise<void> {
    setSaveState("saving");
    try {
      const created = await createNote();
      await saveNote(
        created.id,
        sessionTitle === "" ? "会话总结" : `会话总结 · ${sessionTitle}`,
        summary,
        created.updatedAt,
      );
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setError(toErrorMessage(err));
    }
  }

  const busy = phase === "streaming";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal summary-modal"
        role="dialog"
        aria-modal="true"
        aria-label="会话总结"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="summary-modal__head">
          <h2>会话总结{sessionTitle !== "" ? ` · ${sessionTitle}` : ""}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="summary-modal__body">
          {phase === "loading" && <p className="hint-text">正在查找历史总结…</p>}
          {phase === "done" && savedAt !== null && (
            <p className="summary-modal__stamp">
              上次生成于 {new Date(savedAt * 1000).toLocaleString()} · 重新生成将覆盖
            </p>
          )}
          {summary !== "" && <MarkdownContent content={summary} streaming={busy} />}
          {summary === "" && busy && <p className="hint-text">正在阅读对话并生成总结…</p>}
          {phase === "error" && <p className="error-text">{error}</p>}
        </div>

        <div className="summary-modal__foot">
          {phase === "error" && (
            <button type="button" className="button" onClick={run}>
              重试
            </button>
          )}
          {phase === "done" && (
            <button
              type="button"
              className="button"
              disabled={busy || saveState === "saving"}
              onClick={run}
            >
              重新生成
            </button>
          )}
          {phase === "done" && (
            <button
              type="button"
              className="button button--primary"
              disabled={saveState === "saving" || saveState === "saved"}
              onClick={() => void saveAsNote()}
            >
              {saveState === "saved" ? "已保存到笔记" : saveState === "saving" ? "保存中…" : "保存为笔记"}
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export default SummaryModal;
