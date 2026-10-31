/**
 * Agent 活动浮层：仅当有 agent 在跑时由顶栏入口打开。
 * 显示：当前对话的子代理、正在运行的后台任务（可停止）。
 * 历史运行记录（耗时 / token / 次数）落在每条助手消息的脚注里，不常驻。
 */
import { useEffect, useState } from "react";

import {
  agentLabel,
  listAgentTasks,
  stopAgentTask,
  type AgentTaskView,
} from "../../lib/harness";
import { toErrorMessage } from "../../lib/updater";

interface RunningAgent {
  action: string;
  step: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  running: Record<string, RunningAgent>;
  sessionId: string | null;
  onSpawn: () => void;
}

const ACTIVE_STATUSES = new Set(["running", "pending"]);

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "pending":
      return "排队中";
    default:
      return status;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export default function AgentActivityPanel({
  open,
  onClose,
  running,
  sessionId,
  onSpawn,
}: Props): React.JSX.Element | null {
  const [tasks, setTasks] = useState<AgentTaskView[] | null>(null);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = (): void => {
      void listAgentTasks().then(
        (rows) => {
          if (cancelled) return;
          setTasks(rows);
          setError("");
        },
        (err) => {
          if (cancelled) return;
          setError(toErrorMessage(err));
        },
      );
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open]);

  if (!open) return null;

  const runningAgents = Object.entries(running);
  const activeTasks = (tasks ?? []).filter((task) => ACTIVE_STATUSES.has(task.status));

  async function stopTask(taskId: string): Promise<void> {
    if (stopping !== null) return;
    setStopping(taskId);
    setError("");
    try {
      await stopAgentTask(taskId);
      setTasks(await listAgentTasks());
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setStopping(null);
    }
  }

  return (
    <div className="agent-panel" role="dialog" aria-label="Agent 活动">
      <div className="agent-panel__head">
        <strong>正在运行</strong>
        <button type="button" className="agent-panel__close" aria-label="关闭" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="agent-panel__section">
        <h4>当前对话</h4>
        {runningAgents.length === 0 ? (
          <p className="agent-panel__empty">暂无子代理在运行</p>
        ) : (
          <ul className="agent-panel__running">
            {runningAgents.map(([name, info]) => (
              <li key={name}>
                <span className="agent-panel__dot" aria-hidden="true" />
                <span className="agent-panel__agent">{agentLabel(name)}</span>
                <span className="agent-panel__action">
                  第 {info.step} 步 · {truncate(info.action, 60)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="agent-panel__section">
        <h4>后台任务</h4>
        {tasks === null ? (
          <p className="agent-panel__empty">加载中…</p>
        ) : activeTasks.length === 0 ? (
          <p className="agent-panel__empty">暂无运行中的后台任务</p>
        ) : (
          <ul className="agent-panel__tasks">
            {activeTasks.map((task) => {
              const sameSession = sessionId !== null && task.sessionId === sessionId;
              return (
                <li key={task.taskId} className="agent-task">
                  <div className="agent-task__top">
                    <span className="agent-task__agent">{agentLabel(task.agent)}</span>
                    <span className={"agent-task__status is-" + task.status}>
                      {statusLabel(task.status)}
                    </span>
                    {sameSession && <span className="agent-task__session">本会话</span>}
                  </div>
                  <p className="agent-task__desc">{truncate(task.description, 80)}</p>
                  <div className="agent-task__meta">
                    第 {task.stepsDone} 步 · {task.elapsedSecs}s
                    {task.usage?.totalTokens
                      ? ` · ${task.usage.totalTokens} tok`
                      : ""}
                  </div>
                  <button
                    type="button"
                    className="button agent-task__stop"
                    disabled={stopping !== null}
                    onClick={() => void stopTask(task.taskId)}
                  >
                    {stopping === task.taskId ? "停止中…" : "停止"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error !== "" && <p className="agent-panel__error">{error}</p>}

      <button
        type="button"
        className="button agent-panel__spawn"
        onClick={() => {
          onSpawn();
          onClose();
        }}
      >
        + 新建后台任务
      </button>
    </div>
  );
}
