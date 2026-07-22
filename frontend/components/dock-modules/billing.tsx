"use client";

import { useState, useEffect, useCallback } from "react";
import {
  billingApi,
  type UsageSummary,
  type ProviderUsage,
  type UsageTimeseriesPoint,
  type ModelUsage,
} from "@/lib/api";
import type { DockPanelProps } from "@/lib/dock-registry";

/* ──── SVG Pie Chart ──── */

const COLORS = ["#2563eb", "#7c3aed", "#dc2626", "#16a34a", "#ea580c", "#0891b2"];
const BAR_COLORS: Record<string, string> = {
  openai: "#2563eb",
  anthropic: "#7c3aed",
  deepseek: "#dc2626",
  custom: "#16a34a",
  unknown: "#6b7280",
};

function PieChart({ data }: { data: ProviderUsage[] }) {
  const total = data.reduce((sum, d) => sum + d.total_tokens, 0);
  if (total === 0) return <EmptyChart />;

  const slices = data.reduce<Array<ProviderUsage & { frac: number; startAngle: number; endAngle: number; color: string; }>>((acc, d, i) => {
    const previousEnd = acc.length > 0 ? acc[acc.length - 1].endAngle : -Math.PI / 2;
    const frac = d.total_tokens / total;
    const angle = frac * 2 * Math.PI;
    acc.push({
      ...d,
      frac,
      startAngle: previousEnd,
      endAngle: previousEnd + angle,
      color: COLORS[i % COLORS.length],
    });
    return acc;
  }, []);

  const cx = 90, cy = 90, r = 70;
  const toCoords = (angle: number) => ({
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  });

  return (
    <svg viewBox="0 0 180 180" className="bp-chart">
      {slices.map((s, i) => {
        const start = toCoords(s.startAngle);
        const end = toCoords(s.endAngle);
        const largeArc = s.frac > 0.5 ? 1 : 0;
        const pathData = [
          `M ${cx} ${cy}`,
          `L ${start.x} ${start.y}`,
          `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
          "Z",
        ].join(" ");
        return <path key={i} d={pathData} fill={s.color} stroke="var(--card, #161b22)" strokeWidth="1.5" />;
      })}
    </svg>
  );
}

function EmptyChart() {
  return (
    <svg viewBox="0 0 180 180" className="bp-chart">
      <circle cx="90" cy="90" r="70" fill="none" stroke="var(--border, #30363d)" strokeWidth="1.5" strokeDasharray="6 4" />
      <text x="90" y="88" textAnchor="middle" fill="var(--fg-muted, #8b949e)" fontSize="11" fontFamily="system-ui">暂无数据</text>
    </svg>
  );
}

/* ──── Provider Bar Chart (Credential-level breakdown) ──── */

function ProviderBars({ summary }: { summary: UsageSummary }) {
  const maxTokens = Math.max(1, ...summary.by_credential.map(d => d.total_tokens));

  // Group by provider
  const groups = new Map<string, typeof summary.by_credential>();
  for (const item of summary.by_credential) {
    const key = item.provider || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  if (groups.size === 0) return null;

  return (
    <div className="bp-bars">
      {Array.from(groups.entries()).map(([provider, items]) => {
        const color = BAR_COLORS[provider] || BAR_COLORS.unknown;
        const groupTotal = items.reduce((s, i) => s + i.total_tokens, 0);
        return (
          <div key={provider} className="bp-bar-group">
            <div className="bp-bar-provider">
              <span className="bp-bar-dot" style={{ background: color }} />
              <span className="bp-bar-label">{provider}</span>
              <span className="bp-bar-total">{groupTotal.toLocaleString()} Token</span>
            </div>
            {items.map(item => (
              <div key={item.credential_id ?? "system"} className="bp-bar-item">
                <span className="bp-bar-name">{item.name}</span>
                <div className="bp-bar-track">
                  <div
                    className="bp-bar-fill"
                    style={{
                      width: `${Math.max(2, (item.total_tokens / maxTokens) * 100)}%`,
                      background: color,
                    }}
                  />
                </div>
                <span className="bp-bar-val">
                  {item.total_tokens.toLocaleString()}
                  {(item.cost_estimate ?? 0) > 0 && (
                    <span className="bp-bar-cost"> ¥{item.cost_estimate.toFixed(2)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}


/* ──── Summary Cards ──── */

function SummaryCards({ summary, credCount }: { summary: UsageSummary; credCount: number }) {
  const prompt = summary.total_prompt_tokens ?? 0;
  const completion = summary.total_completion_tokens ?? 0;
  const promptPct = prompt + completion > 0 ? Math.round((prompt / (prompt + completion)) * 100) : 0;
  return (
    <div className="bp-cards">
      <div className="bp-card">
        <div className="bp-card-kicker">用量</div>
        <div className="bp-card-val">{summary.total_tokens.toLocaleString()}</div>
        <div className="bp-card-label">累计 Token 用量</div>
        {prompt + completion > 0 && (
          <div className="bp-card-split">
            <span className="bp-split-in">输入 {prompt.toLocaleString()} ({promptPct}%)</span>
            <span className="bp-split-out">输出 {completion.toLocaleString()} ({100 - promptPct}%)</span>
          </div>
        )}
      </div>
      <div className="bp-card">
        <div className="bp-card-kicker">请求</div>
        <div className="bp-card-val">{summary.total_api_calls.toLocaleString()}</div>
        <div className="bp-card-label">成功请求次数</div>
      </div>
      <div className="bp-card">
        <div className="bp-card-kicker">凭证</div>
        <div className="bp-card-val">{credCount}</div>
        <div className="bp-card-label">产生过用量的凭证数</div>
      </div>
      <div className="bp-card">
        <div className="bp-card-kicker">估算费用</div>
        <div className="bp-card-val">¥{(summary.total_cost ?? 0).toFixed(4)}</div>
        <div className="bp-card-label">
          均次 ¥{summary.total_api_calls > 0
            ? (summary.total_cost / summary.total_api_calls).toFixed(4)
            : "0.0000"}
        </div>
      </div>
    </div>
  );
}

/* ──── Trend Chart (daily tokens + cost) ──── */

function TrendChart({ data }: { data: UsageTimeseriesPoint[] }) {
  if (!data || data.length === 0) {
    return <div className="bp-sub-empty">暂无趋势数据</div>;
  }

  const W = 720, H = 180, padL = 40, padR = 12, padT = 16, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxTokens = Math.max(1, ...data.map(d => d.total_tokens));
  const n = data.length;

  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yT = (v: number) => padT + innerH - (v / maxTokens) * innerH;

  const tokenPath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yT(d.total_tokens)}`).join(" ");
  const areaPath = `${tokenPath} L ${x(n - 1)} ${padT + innerH} L ${x(0)} ${padT + innerH} Z`;

  // Cost on a secondary axis (right), scaled to max cost.
  const maxCost = Math.max(...data.map(d => d.cost_estimate), 0.01);
  const yC = (v: number) => padT + innerH - (v / maxCost) * innerH;
  const costPath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yC(d.cost_estimate)}`).join(" ");

  // X-axis labels: show first, middle, last date.
  const labelIdx = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bp-trend" preserveAspectRatio="none">
      {/* gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((g, i) => {
        const gy = padT + innerH - g * innerH;
        return (
          <g key={i}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--border, #30363d)" strokeWidth="0.5" strokeDasharray="3 3" />
            <text x={padL - 6} y={gy + 3} textAnchor="end" fill="var(--fg-muted, #8b949e)" fontSize="9">
              {Math.round(g * maxTokens).toLocaleString()}
            </text>
          </g>
        );
      })}
      {/* token area + line */}
      <path d={areaPath} fill="rgba(6, 182, 212, 0.12)" />
      <path d={tokenPath} fill="none" stroke="#06b6d4" strokeWidth="1.8" strokeLinejoin="round" />
      {/* cost line (secondary) */}
      {maxCost > 0 && (
        <path d={costPath} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4 3" strokeLinejoin="round" />
      )}
      {/* x labels */}
      {labelIdx.map(i => (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fill="var(--fg-muted, #8b949e)" fontSize="9">
          {data[i].date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

/* ──── Model Breakdown Table ──── */

function ModelTable({ data }: { data: ModelUsage[] }) {
  if (!data || data.length === 0) {
    return <div className="bp-sub-empty">暂无模型用量数据</div>;
  }
  return (
    <div className="bp-table-wrap">
      <table className="bp-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>服务商</th>
            <th className="bp-num">输入 Token</th>
            <th className="bp-num">输出 Token</th>
            <th className="bp-num">调用次数</th>
            <th className="bp-num">估算费用</th>
          </tr>
        </thead>
        <tbody>
          {data.map((m, i) => (
            <tr key={i}>
              <td className="bp-mono">{m.model || "unknown"}</td>
              <td><span className="bp-tag" style={{ background: BAR_COLORS[m.provider] || BAR_COLORS.unknown }}>{m.provider}</span></td>
              <td className="bp-num">{m.prompt_tokens.toLocaleString()}</td>
              <td className="bp-num">{m.completion_tokens.toLocaleString()}</td>
              <td className="bp-num">{m.api_calls.toLocaleString()}</td>
              <td className="bp-num bp-cost-cell">¥{m.cost_estimate.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ──── Legend ──── */

function Legend({ data }: { data: ProviderUsage[] }) {
  if (data.length === 0) return null;
  const total = data.reduce((sum, d) => sum + d.total_tokens, 0);
  return (
    <div className="bp-legend">
      {data.map((d, i) => (
        <div key={d.provider} className="bp-legend-item">
          <span className="bp-legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
          <span className="bp-legend-name">{d.provider}</span>
          <span className="bp-legend-pct">{total > 0 ? Math.round((d.total_tokens / total) * 100) : 0}%</span>
        </div>
      ))}
    </div>
  );
}

/* ──── Info Icon ──── */

function InfoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" fill="currentColor" fillOpacity=".06"/>
      <path d="M12 8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <circle cx="12" cy="16.5" r=".8" fill="currentColor"/>
    </svg>
  );
}

/* ──── Main ──── */

export default function BillingPanel({ isOpen }: DockPanelProps) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [timeseries, setTimeseries] = useState<UsageTimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const [sum, ts] = await Promise.all([
        billingApi.getSummary(days),
        billingApi.getTimeseries(days),
      ]);
      setSummary(sum);
      setTimeseries(ts);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (isOpen) {
      loadSummary();
    }
  }, [isOpen, days, loadSummary]);

  if (!isOpen) return null;

  const credCount = summary?.by_credential?.length ?? 0;
  const modelCount = summary?.by_model?.length ?? 0;

  return (
    <div className="bp-panel">
      <div className="bp-head">
        <div>
          <span className="bp-kicker">Usage Overview</span>
          <h2>用量与计费</h2>
          <p>查看所选时间范围内的 Token 分布、费用趋势及各模型用量明细。</p>
        </div>
        <div className="bp-head-controls">
          <div className="bp-range-card">
            <span className="bp-range-label">时间范围</span>
            <select
              className="bp-days"
              value={days}
              onChange={e => setDays(Number(e.target.value))}
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
              <option value={365}>最近 1 年</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="bp-loading">加载中…</div>
      ) : summary ? (
        <>
          <SummaryCards summary={summary} credCount={credCount} />

          {/* Trend */}
          <div className="bp-section">
            <div className="bp-section-head">
              <h3>用量趋势</h3>
              <span className="bp-section-meta">
                <span className="bp-legend-dot" style={{ background: "#06b6d4" }} /> Token
                <span className="bp-legend-dot" style={{ background: "#f59e0b", marginLeft: 10 }} /> 费用
              </span>
            </div>
            <TrendChart data={timeseries} />
          </div>

          {/* Provider Distribution */}
          <div className="bp-section">
            <div className="bp-section-head">
              <h3>服务商分布</h3>
              <span className="bp-section-meta">{summary.by_provider.length} 个服务商</span>
            </div>
            <div className="bp-pie-row">
              <PieChart data={summary.by_provider} />
              <Legend data={summary.by_provider} />
            </div>
          </div>

          {/* Model Breakdown */}
          <div className="bp-section">
            <div className="bp-section-head">
              <h3>模型明细</h3>
              <span className="bp-section-meta">{modelCount} 个模型</span>
            </div>
            <ModelTable data={summary.by_model ?? []} />
          </div>

          {/* Credential Breakdown */}
          <div className="bp-section">
            <div className="bp-section-head">
              <h3>凭证明细</h3>
              <span className="bp-section-meta">{credCount} 个凭证</span>
            </div>
            <ProviderBars summary={summary} />
          </div>
        </>
      ) : (
        <div className="bp-empty">
          <strong>暂时还没有用量数据</strong>
          <span>当 LLM 请求返回 Token 统计后，这里会显示对应的用量信息。</span>
        </div>
      )}

      <div className="bp-note">
        <span className="bp-note-icon"><InfoIcon /></span>
        <p>Token 数量来自 LLM 接口返回结果，费用为基于服务商公开定价的估算值，仅供参考。</p>
      </div>

      <style jsx global>{`
        .bp-panel {
          height: 100%;
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 22px;
          overflow-y: auto;
          background:
            radial-gradient(circle at top right, rgba(6, 182, 212, 0.1), transparent 28%),
            linear-gradient(180deg, #161b22 0%, #21262d 100%);
          color: #e2e8f0;
          font-family: system-ui, -apple-system, sans-serif;
        }

        /* ── Header ── */
        .bp-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          padding: 18px;
          border-radius: 18px;
          border: 1px solid rgba(48, 54, 61, 0.92);
          background: linear-gradient(135deg, rgba(22, 27, 34, 0.98) 0%, rgba(33, 38, 45, 0.94) 100%);
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.06);
        }
        .bp-kicker {
          display: inline-flex;
          align-items: center;
          margin-bottom: 8px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(6, 182, 212, 0.08);
          color: #06b6d4;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .bp-head h2 {
          font-size: 17px;
          font-weight: 700;
          margin: 0 0 4px;
          letter-spacing: -0.02em;
        }
        .bp-head p {
          margin: 0;
          max-width: 520px;
          color: #8b949e;
          font-size: 12.5px;
        }
        .bp-head-controls {
          display: flex;
          flex-shrink: 0;
        }
        .bp-range-card {
          display: grid;
          gap: 6px;
          min-width: 144px;
          padding: 12px 14px;
          border-radius: 14px;
          background: linear-gradient(160deg, rgba(6, 182, 212, 0.08) 0%, rgba(6, 182, 212, 0.15) 100%);
          border: 1px solid rgba(6, 182, 212, 0.95);
          box-shadow: inset 0 1px 0 rgba(22, 27, 34, 0.65);
        }
        .bp-range-label {
          font-size: 11px;
          font-weight: 700;
          color: #22d3ee;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .bp-days {
          font-size: 12px;
          min-height: 40px;
          padding: 8px 12px;
          border: 1px solid rgba(6, 182, 212, 0.15);
          border-radius: 10px;
          background: rgba(22, 27, 34, 0.92);
          color: #e2e8f0;
          cursor: pointer;
          outline: none;
          font-weight: 600;
          transition: border-color .15s, box-shadow .15s, background .15s;
        }
        .bp-days:focus {
          border-color: #22d3ee;
          box-shadow: 0 0 0 4px rgba(34, 211, 238, 0.15);
          background: #161b22;
        }

        /* ── Loading / Empty ── */
        .bp-loading, .bp-empty {
          text-align: center;
          padding: 36px 24px;
          font-size: 13px;
          color: #8b949e;
          border: 1px dashed #30363d;
          border-radius: 18px;
          background:
            radial-gradient(circle at top, rgba(6, 182, 212, 0.06), transparent 42%),
            rgba(22, 27, 34, 0.75);
        }
        .bp-empty {
          display: grid;
          gap: 6px;
        }
        .bp-empty strong {
          font-size: 14px;
          color: #cbd5e1;
        }
        .bp-empty span {
          color: #8b949e;
        }

        /* ── Cards ── */
        .bp-cards {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
        }
        .bp-card {
          border: 1px solid rgba(48, 54, 61, 0.92);
          border-radius: 18px;
          padding: 16px;
          background: linear-gradient(180deg, #161b22 0%, #21262d 100%);
          box-shadow: 0 14px 32px rgba(0, 0, 0, 0.05);
        }
        .bp-card-kicker {
          font-size: 11px;
          font-weight: 700;
          color: #06b6d4;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 12px;
        }
        .bp-card-val {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          line-height: 1.2;
          color: #e2e8f0;
        }
        .bp-card-label {
          font-size: 12px;
          font-weight: 500;
          color: #8b949e;
          margin-top: 6px;
          line-height: 1.55;
        }
        .bp-card-split {
          display: flex;
          gap: 10px;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(48, 54, 61, 0.6);
          font-size: 10.5px;
          font-weight: 600;
        }
        .bp-split-in { color: #22d3ee; }
        .bp-split-out { color: #f59e0b; }

        /* ── Trend Chart ── */
        .bp-trend {
          width: 100%;
          height: 180px;
          display: block;
        }

        /* ── Model Table ── */
        .bp-table-wrap {
          overflow-x: auto;
          margin: 0 -4px;
        }
        .bp-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .bp-table th {
          text-align: left;
          padding: 8px 10px;
          color: #8b949e;
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          border-bottom: 1px solid rgba(48, 54, 61, 0.92);
          white-space: nowrap;
        }
        .bp-table td {
          padding: 9px 10px;
          border-bottom: 1px solid rgba(48, 54, 61, 0.5);
          color: #cbd5e1;
        }
        .bp-table tr:last-child td { border-bottom: none; }
        .bp-table .bp-num { text-align: right; font-variant-numeric: tabular-nums; }
        .bp-table .bp-mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; color: #e2e8f0; }
        .bp-cost-cell { color: #22d3ee; font-weight: 700; }
        .bp-tag {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10.5px;
          font-weight: 700;
          color: #fff;
          text-transform: capitalize;
        }

        /* ── Section ── */
        .bp-section {
          border: 1px solid rgba(48, 54, 61, 0.92);
          border-radius: 18px;
          padding: 16px 18px 18px;
          background: rgba(22, 27, 34, 0.94);
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.05);
        }
        .bp-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 14px;
        }
        .bp-section h3 {
          font-size: 14px;
          font-weight: 700;
          margin: 0;
          letter-spacing: -0.02em;
          color: #e2e8f0;
        }
        .bp-section-meta {
          display: inline-flex;
          align-items: center;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(6, 182, 212, 0.08);
          border: 1px solid rgba(6, 182, 212, 0.15);
          color: #06b6d4;
          font-size: 11px;
          font-weight: 700;
        }

        /* ── Pie row ── */
        .bp-pie-row {
          display: flex;
          align-items: center;
          gap: 24px;
          min-width: 0;
        }
        .bp-chart {
          width: 152px;
          height: 152px;
          flex-shrink: 0;
          filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.08));
        }

        /* ── Legend ── */
        .bp-legend {
          display: flex;
          flex-direction: column;
          gap: 10px;
          flex: 1;
        }
        .bp-legend-item {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 12.5px;
          padding: 10px 12px;
          border-radius: 12px;
          background: #21262d;
          border: 1px solid rgba(48, 54, 61, 0.92);
        }
        .bp-legend-dot {
          width: 11px;
          height: 11px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .bp-legend-name {
          flex: 1;
          text-transform: capitalize;
          color: #cbd5e1;
          font-weight: 600;
        }
        .bp-legend-pct {
          font-weight: 700;
          color: #e2e8f0;
          font-variant-numeric: tabular-nums;
        }

        /* ── Histogram ── */
        .bp-histogram {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
          gap: 16px;
          align-items: end;
          min-height: 220px;
          padding: 10px 4px 4px;
        }
        .bp-hist-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .bp-hist-value {
          font-size: 11px;
          font-weight: 700;
          color: #e2e8f0;
          font-variant-numeric: tabular-nums;
        }
        .bp-hist-track {
          width: 100%;
          max-width: 72px;
          height: 156px;
          border-radius: 16px;
          background: linear-gradient(180deg, #21262d 0%, #30363d 100%);
          border: 1px solid rgba(48, 54, 61, 0.92);
          display: flex;
          align-items: flex-end;
          justify-content: center;
          padding: 6px;
        }
        .bp-hist-fill {
          width: 100%;
          border-radius: 10px;
          min-height: 14px;
          box-shadow: inset 0 1px 0 rgba(22, 27, 34, 0.35);
          transition: height .35s ease;
        }
        .bp-hist-name {
          font-size: 11px;
          font-weight: 600;
          color: #8b949e;
          text-transform: capitalize;
          text-align: center;
          word-break: break-word;
        }
        .bp-sub-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 180px;
          border: 1px dashed #30363d;
          border-radius: 16px;
          background: rgba(33, 38, 45, 0.82);
          color: #8b949e;
          font-size: 12.5px;
          font-weight: 600;
        }

        /* ── Bars ── */
        .bp-bars {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .bp-bar-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 14px;
          border-radius: 14px;
          background: #21262d;
          border: 1px solid rgba(48, 54, 61, 0.92);
        }
        .bp-bar-provider {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 700;
          color: #e2e8f0;
        }
        .bp-bar-dot {
          width: 9px;
          height: 9px;
          border-radius: 3px;
          flex-shrink: 0;
        }
        .bp-bar-label {
          flex: 1;
          text-transform: capitalize;
        }
        .bp-bar-total {
          font-size: 11px;
          color: #8b949e;
          font-weight: 600;
        }

        .bp-bar-item {
          display: grid;
          grid-template-columns: minmax(84px, 120px) minmax(0, 1fr) 64px;
          align-items: center;
          gap: 10px;
        }
        .bp-bar-name {
          font-size: 12px;
          color: #8b949e;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 600;
        }
        .bp-bar-track {
          flex: 1;
          height: 8px;
          background: #30363d;
          border-radius: 999px;
          overflow: hidden;
        }
        .bp-bar-fill {
          height: 100%;
          border-radius: 999px;
          transition: width .4s ease;
          min-width: 2px;
          box-shadow: 0 0 0 1px rgba(22, 27, 34, 0.28) inset;
        }
        .bp-bar-val {
          font-size: 11px;
          color: #8b949e;
          text-align: right;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .bp-bar-cost {
          margin-left: 6px;
          color: #22d3ee;
          font-weight: 600;
        }

        /* ── Note ── */
        .bp-note {
          font-size: 12px;
          color: #8b949e;
          padding: 14px 15px;
          background: linear-gradient(180deg, #21262d 0%, rgba(6, 182, 212, 0.08) 100%);
          border: 1px solid rgba(6, 182, 212, 0.92);
          border-radius: 16px;
          line-height: 1.7;
          display: flex;
          gap: 10px;
          margin-top: auto;
          flex-shrink: 0;
          box-shadow: inset 0 1px 0 rgba(22, 27, 34, 0.7);
        }
        .bp-note-icon {
          flex-shrink: 0;
          margin-top: 2px;
          color: #06b6d4;
        }
        .bp-note p { margin: 0; }

        /* Light mode overrides */
        html:not(.dark) .bp-panel {
          background: radial-gradient(circle at top right, rgba(6, 182, 212, 0.08), transparent 28%), linear-gradient(180deg, var(--card) 0%, var(--paper) 100%);
          color: var(--foreground);
        }
        html:not(.dark) .bp-head {
          border-color: var(--border);
          background: linear-gradient(135deg, var(--card) 0%, var(--paper) 100%);
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.04);
        }
        html:not(.dark) .bp-kicker {
          background: rgba(6, 182, 212, 0.06);
          color: var(--accent);
        }
        html:not(.dark) .bp-head h2 { color: var(--foreground); }
        html:not(.dark) .bp-head p { color: var(--muted-foreground); }
        html:not(.dark) .bp-range-card {
          background: linear-gradient(160deg, rgba(6, 182, 212, 0.06) 0%, rgba(6, 182, 212, 0.1) 100%);
          border-color: rgba(6, 182, 212, 0.5);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
        }
        html:not(.dark) .bp-range-label { color: var(--accent); }
        html:not(.dark) .bp-days {
          border-color: rgba(6, 182, 212, 0.2);
          background: var(--card);
          color: var(--foreground);
        }
        html:not(.dark) .bp-days:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 4px rgba(8, 145, 178, 0.12);
          background: var(--card);
        }
        html:not(.dark) .bp-loading,
        html:not(.dark) .bp-empty {
          color: var(--muted-foreground);
          border-color: var(--border);
          background: radial-gradient(circle at top, rgba(6, 182, 212, 0.04), transparent 42%), var(--paper);
        }
        html:not(.dark) .bp-empty strong { color: var(--foreground); }
        html:not(.dark) .bp-empty span { color: var(--muted-foreground); }
        html:not(.dark) .bp-card {
          border-color: var(--border);
          background: linear-gradient(180deg, var(--card) 0%, var(--paper) 100%);
          box-shadow: 0 14px 32px rgba(0, 0, 0, 0.04);
        }
        html:not(.dark) .bp-card-kicker { color: var(--accent); }
        html:not(.dark) .bp-card-val { color: var(--foreground); }
        html:not(.dark) .bp-card-label { color: var(--muted-foreground); }
        html:not(.dark) .bp-split-in { color: var(--accent); }
        html:not(.dark) .bp-split-out { color: #d97706; }
        html:not(.dark) .bp-table th { color: var(--muted-foreground); border-color: var(--border); }
        html:not(.dark) .bp-table td { color: var(--foreground); border-color: var(--border); }
        html:not(.dark) .bp-table .bp-mono { color: var(--foreground); }
        html:not(.dark) .bp-cost-cell { color: var(--accent); }
        html:not(.dark) .bp-card-split { border-color: var(--border); }
        html:not(.dark) .bp-section {
          border-color: var(--border);
          background: var(--card);
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.04);
        }
        html:not(.dark) .bp-section h3 { color: var(--foreground); }
        html:not(.dark) .bp-section-meta {
          background: rgba(6, 182, 212, 0.06);
          border-color: rgba(6, 182, 212, 0.2);
          color: var(--accent);
        }
        html:not(.dark) .bp-chart { filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.04)); }
        html:not(.dark) .bp-legend-item {
          background: var(--paper);
          border-color: var(--border);
        }
        html:not(.dark) .bp-legend-name { color: var(--foreground); }
        html:not(.dark) .bp-legend-pct { color: var(--foreground); }
        html:not(.dark) .bp-hist-value { color: var(--foreground); }
        html:not(.dark) .bp-hist-track {
          background: linear-gradient(180deg, var(--paper) 0%, var(--paper-3) 100%);
          border-color: var(--border);
        }
        html:not(.dark) .bp-hist-fill { box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.06); }
        html:not(.dark) .bp-hist-name { color: var(--muted-foreground); }
        html:not(.dark) .bp-sub-empty {
          border-color: var(--border);
          background: var(--paper);
          color: var(--muted-foreground);
        }
        html:not(.dark) .bp-bar-group {
          background: var(--paper);
          border-color: var(--border);
        }
        html:not(.dark) .bp-bar-provider { color: var(--foreground); }
        html:not(.dark) .bp-bar-total { color: var(--muted-foreground); }
        html:not(.dark) .bp-bar-name { color: var(--muted-foreground); }
        html:not(.dark) .bp-bar-track { background: var(--paper-3); }
        html:not(.dark) .bp-bar-fill { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08) inset; }
        html:not(.dark) .bp-bar-val { color: var(--muted-foreground); }
        html:not(.dark) .bp-bar-cost { color: var(--accent); }
        html:not(.dark) .bp-note {
          color: var(--muted-foreground);
          background: linear-gradient(180deg, var(--paper) 0%, rgba(6, 182, 212, 0.06) 100%);
          border-color: rgba(6, 182, 212, 0.5);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
        }
        html:not(.dark) .bp-note-icon { color: var(--accent); }

        @media (max-width: 760px) {
          .bp-head,
          .bp-section-head,
          .bp-pie-row {
            flex-direction: column;
            align-items: stretch;
          }
          .bp-head-controls {
            width: 100%;
          }
          .bp-range-card {
            width: 100%;
          }
          .bp-cards {
            grid-template-columns: repeat(2, 1fr);
          }
          .bp-chart {
            margin: 0 auto;
          }
          .bp-histogram {
            grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
          }
          .bp-bar-item {
            grid-template-columns: 1fr;
            gap: 6px;
          }
          .bp-bar-val {
            text-align: left;
          }
        }
      `}</style>
    </div>
  );
}
