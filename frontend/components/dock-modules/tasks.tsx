"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Activity, CheckCircle2, XCircle, Clock, Loader2, Wifi, WifiOff } from "lucide-react";
import { type TaskData, type WsTaskMessage, getTaskTypeLabel, getTaskStatusLabel } from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/tasks";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("bili_session");
}

export default function TasksPanel({ isOpen }: DockPanelProps) {
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;          // always current, no closure staleness

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    // Close any existing connection first (prevents StrictMode double-connect)
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
    }

    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsTaskMessage = JSON.parse(event.data);
        if (msg.type === "tasks" && msg.tasks) {
          setTasks(msg.tasks);
        } else if (msg.type === "task_update" && msg.task) {
          setTasks(prev => {
            const idx = prev.findIndex(t => t.task_id === msg.task!.task_id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = msg.task!;
              return next;
            }
            return [msg.task!, ...prev];
          });
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (isOpenRef.current) {
        reconnectTimer.current = setTimeout(connect, 5000);
      }
    };

    ws.onerror = () => {
      setError("WebSocket 连接失败");
    };

    wsRef.current = ws;
  }, []);  // stable — reads isOpen from ref

  useEffect(() => {
    if (isOpen) {
      connect();
    }
    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [isOpen, connect]); // Note: connect() is NOT a dep — it reads isOpen from ref, not closure

  if (!isOpen) return null;

  return (
    <div className="tm-root">
      {/* header */}
      <div className="tm-head">
        <div>
          <span className="tm-kicker">实时监控</span>
          <h2>异步任务</h2>
        </div>
        <div className={`tm-status ${connected ? "live" : ""}`}>
          {connected ? <><Wifi size={13} /> 已连接</> : <><WifiOff size={13} /> 未连接</>}
        </div>
      </div>

      {/* error */}
      {error && <div className="tm-error">{error}</div>}

      {/* task list */}
      {tasks.length === 0 ? (
        <div className="tm-empty">
          <Activity size={28} style={{ opacity: 0.3 }} />
          <p>暂无异步任务</p>
          <span>向量化、ASR、知识库构建等操作会在此处显示进度。</span>
        </div>
      ) : (
        <div className="tm-list">
          {tasks.map(t => (
            <TaskCard key={t.task_id} task={t} />
          ))}
        </div>
      )}

      <style jsx global>{TM_CSS}</style>
    </div>
  );
}

/* ─── Task card ─── */

function TaskCard({ task }: { task: TaskData }) {
  const statusIcon = {
    pending: <Clock size={15} className="tm-si pending" />,
    processing: <Loader2 size={15} className="tm-si processing animate-spin" />,
    done: <CheckCircle2 size={15} className="tm-si done" />,
    failed: <XCircle size={15} className="tm-si failed" />,
  }[task.status] ?? <Activity size={15} className="tm-si" />;

  return (
    <div className="tm-card">
      <div className="tm-card-top">
        <div className="tm-type-badge">{getTaskTypeLabel(task.task_type)}</div>
        <div className="tm-status-badge" data-status={task.status}>{getTaskStatusLabel(task.status)}</div>
      </div>
      <div className="tm-card-mid">
        {statusIcon}
        <div className="tm-progress-track">
          <div
            className={`tm-progress-fill ${task.status}`}
            style={{ width: `${Math.min(100, Math.max(0, task.progress ?? 0))}%` }}
          />
        </div>
        <span className="tm-pct">{task.progress ?? 0}%</span>
      </div>
      {/* steps */}
      {task.steps && task.steps.length > 0 && (
        <div className="tm-steps">
          {task.steps.map((s, i) => (
            <div key={i} className="tm-step">
              <span className={`tm-step-dot ${s.status}`} />
              <span className="tm-step-name">{s.name}</span>
              <span className="tm-step-pct">{s.progress}%</span>
            </div>
          ))}
        </div>
      )}
      {/* error */}
      {task.error && <div className="tm-task-error">{task.error.length > 120 ? task.error.slice(0, 120) + "…" : task.error}</div>}
      {/* timestamp */}
      <div className="tm-card-foot">
        <span>{task.created_at ? new Date(task.created_at).toLocaleString() : ""}</span>
      </div>
    </div>
  );
}

/* ─── CSS ─── */

const TM_CSS = `
  .tm-root {
    height:100%;flex:1;display:flex;flex-direction:column;gap:14px;
    padding:22px;overflow-y:auto;
    background:var(--background,#0d1117);
    color:var(--foreground,#e6edf3);
    font-family:system-ui,-apple-system,sans-serif;
  }
  .tm-head { display:flex;align-items:center;justify-content:space-between; }
  .tm-kicker { display:inline-flex;align-items:center;margin-bottom:6px;padding:4px 10px;border-radius:999px;background:rgba(6,182,212,.08);color:#06b6d4;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase; }
  .tm-head h2 { font-size:17px;font-weight:700;margin:0;letter-spacing:-.02em; }
  .tm-status { display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:500;background:rgba(48,54,61,.5);color:#8b949e;border:1px solid rgba(48,54,61,.6); }
  .tm-status.live { background:rgba(22,163,74,.08);color:#4ade80;border-color:rgba(22,163,74,.15); }

  .tm-error { padding:10px 14px;border-radius:10px;background:rgba(220,38,38,.08);color:#f87171;font-size:13px;border:1px solid rgba(220,38,38,.15); }

  .tm-empty { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--muted-foreground,#8b949e);text-align:center;padding:40px 20px; }
  .tm-empty p { margin:0;font-size:15px;font-weight:600; }
  .tm-empty span { font-size:12px;max-width:260px; }

  .tm-list { display:flex;flex-direction:column;gap:10px; }

  .tm-card {
    border:1px solid var(--border,rgba(48,54,61,.6));border-radius:12px;
    background:var(--card,#161b22);padding:14px 16px;
    display:flex;flex-direction:column;gap:8px;
  }
  .tm-card-top { display:flex;align-items:center;justify-content:space-between; }
  .tm-type-badge { font-size:11px;font-weight:600;color:#06b6d4;background:rgba(6,182,212,.08);padding:3px 10px;border-radius:6px; }
  .tm-status-badge { font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px; }
  .tm-status-badge[data-status="done"]       { background:rgba(22,163,74,.08);color:#4ade80; }
  .tm-status-badge[data-status="processing"] { background:rgba(6,182,212,.08);color:#06b6d4; }
  .tm-status-badge[data-status="failed"]     { background:rgba(220,38,38,.08);color:#f87171; }
  .tm-status-badge[data-status="pending"]    { background:rgba(48,54,61,.3);color:#8b949e; }

  .tm-card-mid { display:flex;align-items:center;gap:10px; }
  .tm-si { flex-shrink:0; }
  .tm-si.done { color:#4ade80; }
  .tm-si.failed { color:#f87171; }
  .tm-si.processing { color:#06b6d4; }
  .tm-si.pending { color:#8b949e; }

  .tm-progress-track { flex:1;height:6px;border-radius:3px;background:rgba(48,54,61,.5);overflow:hidden; }
  .tm-progress-fill { height:100%;border-radius:3px;transition:width .5s ease; }
  .tm-progress-fill.processing { background:linear-gradient(90deg,#06b6d4,#22d3ee); }
  .tm-progress-fill.done { background:#4ade80; }
  .tm-progress-fill.failed { background:#f87171; }
  .tm-progress-fill.pending { background:#8b949e; }
  .tm-pct { font-size:12px;font-weight:600;min-width:32px;text-align:right;color:var(--muted-foreground,#8b949e); }

  .tm-steps { display:flex;flex-direction:column;gap:4px;padding-top:4px;border-top:1px solid rgba(48,54,61,.3); }
  .tm-step { display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted-foreground,#8b949e); }
  .tm-step-dot { width:7px;height:7px;border-radius:50%;flex-shrink:0; }
  .tm-step-dot.done { background:#4ade80; }
  .tm-step-dot.processing { background:#06b6d4; }
  .tm-step-dot.failed { background:#f87171; }
  .tm-step-dot.pending { background:#8b949e; }
  .tm-step-name { flex:1; }
  .tm-step-pct { font-weight:600;min-width:28px;text-align:right; }

  .tm-task-error { font-size:11px;color:#f87171;background:rgba(220,38,38,.06);padding:6px 10px;border-radius:6px;word-break:break-all; }
  .tm-card-foot { font-size:11px;color:var(--muted-foreground,#8b949e); }

  /* light mode */
  html:not(.dark) .tm-root { background:var(--paper,#f9fafb);color:var(--foreground,#111827); }
  html:not(.dark) .tm-card { border-color:var(--border,#e5e7eb);background:#fff; }
  html:not(.dark) .tm-status { background:#f3f4f6;color:#6b7280;border-color:#e5e7eb; }
  html:not(.dark) .tm-status.live { background:rgba(22,163,74,.06);color:#16a34a;border-color:rgba(22,163,74,.12); }
  html:not(.dark) .tm-empty { color:#9ca3af; }
  html:not(.dark) .tm-progress-track { background:#f3f4f6; }

  @keyframes tmSpin { to { transform:rotate(360deg) } }
  .animate-spin { animation:tmSpin 1s linear infinite; }
`;
