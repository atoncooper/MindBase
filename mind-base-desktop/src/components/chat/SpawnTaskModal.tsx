/**
 * 后台任务弹窗：选 agent + 写任务描述（+ 可选步数预算），提交即
 * `agent_task_spawn`，主对话与流式状态完全不受影响。
 *
 * 任务挂在当前会话下（sessionId = 当前 activeId）；草稿态还没有会话时
 * 提示先发一条消息。提交/失败都经 toast 反馈，运行中的任务在
 * 「设置 → Agent」页可查看、注入与停止。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_LABELS, spawnAgentTask } from "../../lib/harness";
import { useToast } from "../../lib/toast";
import { toErrorMessage } from "../../lib/updater";

interface SpawnTaskModalProps {
  /** 当前会话 id；null = 还没有会话（先发一条消息再由后端建会话）。 */
  sessionId: string | null;
  onClose: () => void;
}

function SpawnTaskModal({ sessionId, onClose }: SpawnTaskModalProps): React.JSX.Element {
  const toast = useToast();
  const [agent, setAgent] = useState("chat");
  const [task, setTask] = useState("");
  const [maxSteps, setMaxSteps] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const taskRef = useRef<HTMLTextAreaElement>(null);
  // 最新 onClose 走 ref：ChatView 流式期间会频繁重渲染，闭包身份变化不能
  // 触发重聚焦（否则用户在弹窗里切到别的控件会被拽回任务描述框）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    taskRef.current?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** 步数预算：留空 / 非法值 = 用后端默认。 */
  function parsedMaxSteps(): number | undefined {
    const value = Number.parseInt(maxSteps.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  async function submit(): Promise<void> {
    const trimmed = task.trim();
    if (busy || trimmed === "" || sessionId === null) return;
    setBusy(true);
    setError("");
    try {
      await spawnAgentTask({
        agent,
        task: trimmed,
        sessionId,
        maxSteps: parsedMaxSteps(),
      });
      toast.success("已提交后台任务", { title: "后台任务" });
      onClose();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = sessionId !== null && task.trim() !== "" && !busy;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // 提交中不响应点外部关闭，避免「任务已发出但弹窗已消失」的错觉。
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal spawn-modal" role="dialog" aria-modal="true" aria-label="提交后台任务">
        <div className="modal__head">
          <h3 className="modal__title">后台任务</h3>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <p className="spawn-modal__intro">
          把一件独立工作交给后台 agent 执行，当前对话照常进行；运行中的任务可在
          「设置 → Agent」页查看进度、注入要求或停止。
        </p>

        <label className="spawn-modal__row">
          <span className="spawn-modal__label">agent</span>
          <select
            className="cfg-input spawn-modal__agent"
            value={agent}
            disabled={busy}
            onChange={(event) => setAgent(event.target.value)}
          >
            {Object.entries(AGENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="spawn-modal__row spawn-modal__row--stack">
          <span className="spawn-modal__label">任务描述</span>
          <textarea
            ref={taskRef}
            className="cfg-input spawn-modal__task"
            rows={5}
            placeholder="如：把本次对话里关于检索链路的结论整理成一篇笔记"
            value={task}
            disabled={busy}
            onChange={(event) => setTask(event.target.value)}
          />
        </label>

        <label className="spawn-modal__row">
          <span className="spawn-modal__label">步数预算（可选）</span>
          <input
            className="cfg-input spawn-modal__budget"
            type="number"
            min={1}
            step={1}
            placeholder="留空 = 跟随默认"
            value={maxSteps}
            disabled={busy}
            onChange={(event) => setMaxSteps(event.target.value)}
          />
        </label>

        {sessionId === null && (
          <p className="spawn-modal__gate">
            当前还没有会话——先在输入框发一条消息，后台任务会挂在该会话下。
          </p>
        )}
        {error !== "" && <p className="error-text">{error}</p>}

        <div className="spawn-modal__actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? "提交中…" : "提交任务"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default SpawnTaskModal;
