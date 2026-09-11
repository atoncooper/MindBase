/**
 * Agent 状态 pane：运行中的 agent 任务（现在是谁在工作/有几个在 working）、
 * harness 运行概览与注册工具清单。面板可见时每 3 秒轮询一次；隐藏即停止。
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  getHarnessHealth,
  getHarnessTools,
  injectAgentTask,
  listAgentTasks,
  stopAgentTask,
} from "../lib/harness";
import type { AgentTaskView, HarnessHealth, HarnessTool } from "../lib/harness";
import { agentLabel } from "../lib/harness";
import { toErrorMessage } from "../lib/updater";
import type { Feedback } from "../lib/ui-state";

function agentBadge(name: string): ReactNode {
  return (
    <span className="agent-badge" key={name}>
      {agentLabel(name)}
    </span>
  );
}

const PLAN_MARKS: Record<string, string> = {
  done: "✓",
  in_progress: "▶",
  failed: "✗",
  skipped: "⊘",
  pending: "·",
};

const STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  budget_exhausted: "预算耗尽",
};

function statusBadge(status: string): ReactNode {
  const cls =
    status === "running"
      ? "status status--live"
      : status === "done"
        ? "status status--ok"
        : status === "failed"
          ? "status status--error"
          : "status";
  return <span className={cls}>{STATUS_LABELS[status] ?? status}</span>;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  return `${minutes}m${secs % 60}s`;
}

interface AgentStatusViewProps {
  /** Visibility is owned by the parent tab switcher; state stays mounted. */
  hidden: boolean;
}

function AgentStatusView({ hidden }: AgentStatusViewProps) {
  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [tasks, setTasks] = useState<AgentTaskView[] | null>(null);
  const [tools, setTools] = useState<HarnessTool[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 注入草稿与进行中标记（按 task_id 索引）。
  const [injectDrafts, setInjectDrafts] = useState<Record<string, string>>({});
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const [h, t, toolList] = await Promise.all([
          getHarnessHealth(),
          listAgentTasks(),
          getHarnessTools(),
        ]);
        if (cancelled) return;
        setHealth(h);
        setTasks(t);
        setTools(toolList);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(toErrorMessage(err));
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hidden]);

  async function runTaskAction(taskId: string, action: () => Promise<void>, okText: string) {
    setBusyTaskId(taskId);
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: "ok", text: okText });
    } catch (err) {
      setFeedback({ kind: "error", text: toErrorMessage(err) });
    } finally {
      setBusyTaskId(null);
    }
  }

  const runningCount = (tasks ?? []).filter((task) => task.status === "running").length;

  return (
    <div className="settings-pane" hidden={hidden}>
      <section className="card">
        <h2 className="card__title">
          <span className="card__index">01</span>运行概览
        </h2>
        {health === null ? (
          <p className="placeholder">
            {loadError !== null ? `读取失败：${loadError}` : "读取中…"}
          </p>
        ) : (
          <dl className="rows">
            <div className="row">
              <dt className="row__label">正在工作的 agent</dt>
              <dd className="row__value">
                <span className={runningCount > 0 ? "status status--live" : "status"}>
                  {runningCount > 0 ? `${runningCount} 个任务执行中` : "空闲"}
                </span>
              </dd>
            </div>
            <div className="row">
              <dt className="row__label">活跃会话</dt>
              <dd className="row__value">{health.activeSessions}</dd>
            </div>
            <div className="row">
              <dt className="row__label">累计工具调用</dt>
              <dd className="row__value">
                {health.runtime.totals.callCount}
                {health.runtime.totals.errorCount > 0 && (
                  <span className="status status--error" title="工具级错误次数">
                    {" "}
                    错误 {health.runtime.totals.errorCount}
                  </span>
                )}
              </dd>
            </div>
            <div className="row">
              <dt className="row__label">可路由 agent</dt>
              <dd className="row__value">{health.routableAgents.join("、") || "无"}</dd>
            </div>
            {health.breakers.length > 0 && (
              <div className="row">
                <dt className="row__label">熔断器</dt>
                <dd className="row__value">
                  {health.breakers.map((breaker) => (
                    <span
                      key={breaker.agent}
                      className={breaker.state === "Open" ? "status status--error" : "status"}
                      title={`失败 ${breaker.failures} 次`}
                    >
                      {breaker.agent}: {breaker.state}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">02</span>Agent 任务
        </h2>
        {tasks === null ? (
          <p className="placeholder">读取中…</p>
        ) : tasks.length === 0 ? (
          <p className="placeholder">当前没有后台任务。</p>
        ) : (
          tasks.map((task) => (
            <div className="agent-task" key={task.taskId}>
              <div className="agent-task__head">
                {agentBadge(task.agent)}
                <span className="tool-row__name">{task.taskId}</span>
                {statusBadge(task.status)}
              </div>
              <p className="agent-task__meta">{task.description}</p>
              <p className="agent-task__meta">
                步骤 {task.stepsDone}/{task.maxSteps} · 工具 {task.toolCalls}/
                {task.maxToolCalls} · 已运行 {formatDuration(task.elapsedSecs)}
              </p>
              {task.plan !== null && (
                <div className="plan-panel">
                  <div className="plan-panel__head">
                    任务计划 v{task.plan.version} · {task.plan.done}/{task.plan.total} 完成
                  </div>
                  <ol className="plan-panel__steps">
                    {task.plan.steps.map((step, i) => (
                      <li key={i} className={`plan-step plan-step--${step.status}`}>
                        <span className="plan-step__mark">
                          {PLAN_MARKS[step.status] ?? "·"}
                        </span>
                        <span className="plan-step__desc">{step.desc}</span>
                        {step.note !== "" && (
                          <span className="plan-step__note"> — {step.note}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {task.result !== null && (
                <p className="hint-text">结果：{task.result.slice(0, 200)}</p>
              )}
              {task.error !== null && <p className="error-text">错误：{task.error}</p>}
              {task.status === "running" && (
                <div className="agent-task__inject">
                  <input
                    className="cfg-input"
                    type="text"
                    placeholder="注入消息：询问进度 / 追加要求（在下一步生效）"
                    value={injectDrafts[task.taskId] ?? ""}
                    onChange={(event) =>
                      setInjectDrafts((prev) => ({
                        ...prev,
                        [task.taskId]: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    className="button"
                    disabled={
                      busyTaskId === task.taskId ||
                      (injectDrafts[task.taskId] ?? "").trim() === ""
                    }
                    onClick={() =>
                      void runTaskAction(
                        task.taskId,
                        () =>
                          injectAgentTask(
                            task.taskId,
                            (injectDrafts[task.taskId] ?? "").trim(),
                          ),
                        "✓ 已注入，将在该 agent 下一步生效",
                      )
                    }
                  >
                    注入
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busyTaskId === task.taskId}
                    onClick={() =>
                      void runTaskAction(
                        task.taskId,
                        () => stopAgentTask(task.taskId),
                        "已请求停止（在下个步边界生效）",
                      )
                    }
                  >
                    停止
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        {feedback !== null && (
          <p className={feedback.kind === "error" ? "error-text" : "hint-text"}>
            {feedback.text}
          </p>
        )}
        <p className="hint-text">
          任务由对话或命令发起；注入与停止在下个步边界生效，不打断正在生成的流。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">
          <span className="card__index">03</span>工具清单
        </h2>
        {tools === null ? (
          <p className="placeholder">读取中…</p>
        ) : tools.length === 0 ? (
          <p className="placeholder">工具注册表为空</p>
        ) : (
          tools.map((tool) => (
            <div className="tool-row" key={tool.name}>
              <span className="tool-row__name">{tool.name}</span>
              <span className="tool-row__agents">
                {tool.agents.map((agent) => agentBadge(agent))}
              </span>
              <p className="tool-row__desc">{tool.description}</p>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

export default AgentStatusView;
