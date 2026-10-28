/**
 * 数据 tab：CSV/XLSX 导入 → 画像；分析脚本在本机执行。
 * 复用桌面端 .card/.button/.text-input/.status 与主题变量，无独立图标。
 */

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useToast } from "../../lib/toast";
import {
  cellText, datasetMissingTotal, importDataset, listDatasets, parseDatasetProfile, runAnalysis,
  type AnalysisResult, type DatasetRow,
} from "../../lib/research";
import { errorText, formatDate } from "./common";

const SCRIPT_TEMPLATE = [
  "# 分析脚本：在本项目根目录执行（cwd = research/<项目ID>），可用相对路径访问 data/ 与 analysis/",
  "import pandas as pd",
  "",
  "# df = pd.read_csv(\"data/original/<文件名>.csv\")",
  "# print(df.head())",
  "# print(df.describe())",
  'print("hello from analysis")',
].join("\n");

function numberText(value: number | string | null): string {
  if (value === null) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  return value === "" ? "—" : value;
}

export default function DataTab({ projectId }: { projectId: string }): React.JSX.Element {
  const toast = useToast();
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scriptName, setScriptName] = useState("分析脚本");
  const [script, setScript] = useState(SCRIPT_TEMPLATE);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDatasets(projectId)
      .then((rows) => { if (!cancelled) setDatasets(rows); })
      .catch((err) => { if (!cancelled) setError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  async function pickFile(): Promise<void> {
    const selected = await open({ multiple: false, title: "选择要导入的数据文件", filters: [{ name: "数据文件", extensions: ["csv", "xlsx", "xls"] }] });
    const path = (Array.isArray(selected) ? selected[0] : selected) ?? null;
    if (path === null || path === "") return;
    setImporting(true); setError(null); setNotice(null);
    try {
      const row = await importDataset(projectId, path);
      setDatasets((prev) => [row, ...prev]);
      setExpandedId(row.id);
      setNotice("已导入 " + row.name + "（" + (row.rows ?? "?") + " 行 × " + (row.cols ?? "?") + " 列）；原文件不受影响。");
      toast.success("数据导入完成", { title: "数据集" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "数据导入失败" }); }
    finally { setImporting(false); }
  }

  async function handleRun(): Promise<void> {
    if (script.trim() === "") { setError("请先填写分析脚本内容"); return; }
    setRunning(true); setError(null); setNotice(null); setResult(null);
    try {
      const name = scriptName.trim() === "" ? "分析脚本" : scriptName.trim();
      const output = await runAnalysis(projectId, name, script);
      setResult(output);
      toast.success(output.exitCode === 0 ? "分析脚本执行完成" : "脚本退出码 " + output.exitCode, { title: "运行分析" });
    } catch (err) { setError(errorText(err)); toast.error(errorText(err), { title: "运行分析失败" }); }
    finally { setRunning(false); }
  }

  return (
    <div className="rs-pane">
      {error !== null && <p className="error-text" style={{ margin: 0 }} onClick={() => setError(null)}>{error}</p>}
      {notice !== null && <p className="hint-text" style={{ margin: 0 }} onClick={() => setNotice(null)}>{notice}</p>}

      <div className="card">
        <div className="research-section-head">
          <h3>数据集</h3>
          <span className="hint-text">{datasets.length + " 个 · 仅保存在本机"}</span>
          <span className="spacer" />
          <button type="button" className="button research-btn-sm" disabled={importing} onClick={() => void pickFile()}>
            {importing ? "导入中…" : "选择文件"}
          </button>
        </div>
        <p className="hint-text">支持 CSV / XLSX（旧版 .xls 请先另存为 .xlsx）。导入会复制到项目目录并生成行数、列类型与缺失值画像。</p>

        {loading ? <p className="hint-text">加载数据集…</p> : datasets.length === 0 ? (
          <div className="research-empty"><p>还没有数据集。先把原始数据导入，确认画像无误后再写分析脚本。</p></div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {datasets.map((row) => {
              const profile = parseDatasetProfile(row.profileJson);
              const missing = datasetMissingTotal(profile);
              const expanded = expandedId === row.id;
              return (
                <div key={row.id} className="research-dataset">
                  <div className="research-dataset__head">
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div className="research-dataset__name">{row.name}</div>
                      <div className="research-dataset__path" title={row.path}>{row.path}{row.sha256 !== "" ? " · 摘要 " + row.sha256.slice(0, 12) : ""}</div>
                    </div>
                    <span className="chip">{row.rows ?? "?"} 行</span>
                    <span className="chip">{row.cols ?? "?"} 列</span>
                    <span className="chip">缺失 {missing ?? "?"}</span>
                    <span className="chip">{row.privacy === "local" ? "仅本地" : row.privacy}</span>
                    <span className="hint-text">{formatDate(row.createdAt)}</span>
                    <button type="button" className="button research-btn-sm" disabled={profile === null}
                      onClick={() => setExpandedId(expanded ? null : row.id)}>{expanded ? "收起画像" : "查看画像"}</button>
                  </div>

                  {expanded && profile !== null && (
                    <div style={{ marginTop: 8 }}>
                      {Array.isArray(profile.columns) && profile.columns.length > 0 ? (
                        <div className="rs-table-wrap"><table className="research-table" style={{ fontSize: 12.5 }}>
                          <thead><tr><th>列</th><th>类型</th><th>缺失</th><th>唯一值</th><th>最小</th><th>最大</th><th>均值</th></tr></thead>
                          <tbody>
                            {profile.columns.map((column, index) => (
                              <tr key={row.id + "-" + index}>
                                <td>{column.name}</td><td>{column.type}</td>
                                <td>{numberText(column.missing)}</td><td>{numberText(column.unique)}</td>
                                <td>{numberText(column.min)}</td><td>{numberText(column.max)}</td><td>{numberText(column.mean)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table></div>
                      ) : <p className="hint-text">画像没有列信息（可能为空文件或解析未产出列画像）。</p>}

                      {Array.isArray(profile.preview) && profile.preview.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <p className="hint-text">数据预览（前 {profile.preview.length} 行）</p>
                          <div className="rs-table-wrap"><table className="research-table" style={{ fontSize: 11.5, width: "auto" }}>
                            <tbody>
                              {profile.preview.map((previewRow, rowIndex) => (
                                <tr key={row.id + "-p" + rowIndex}>
                                  {previewRow.map((cell, cellIndex) => (
                                    <td key={cellIndex} title={cellText(cell)}
                                      style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: rowIndex === 0 ? 600 : 400 }}>
                                      {cellText(cell)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table></div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="research-section-head"><h3>分析脚本</h3><span className="hint-text">Python · 本机执行 · 默认 120s 超时</span></div>
        <div className="research-field" style={{ maxWidth: 360 }}>
          <label htmlFor="analysis-script-name">脚本名称（用于落盘文件名）</label>
          <input id="analysis-script-name" className="text-input" value={scriptName} onChange={(event) => setScriptName(event.target.value)} />
        </div>
        <div className="research-field" style={{ marginTop: 12 }}>
          <label htmlFor="analysis-script">脚本内容</label>
          <textarea id="analysis-script" className="research-textarea research-mono" style={{ minHeight: 180 }}
            value={script} onChange={(event) => setScript(event.target.value)} spellCheck={false} />
        </div>
        <div className="research-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <span className="hint-text" style={{ flex: 1 }}>脚本写入 analysis/scripts/，stdout 落到 analysis/outputs/。</span>
          <button type="button" className="button button--primary" disabled={running} onClick={() => void handleRun()}>
            {running ? "运行中…" : "运行分析"}
          </button>
        </div>

        {result !== null && (
          <div style={{ marginTop: 12 }}>
            <div className="research-row" style={{ marginBottom: 6 }}>
              <span className={result.exitCode === 0 ? "status status--ok" : "status status--error"}>退出码 {result.exitCode}</span>
              <span className="hint-text" style={{ flex: 1, wordBreak: "break-all" }}>脚本：{result.scriptPath}</span>
            </div>
            <pre className="research-console">{result.stdout.trim() === "" ? "（无标准输出）" : result.stdout}</pre>
            {result.stderr.trim() !== "" && <pre className="research-console research-console--error">{result.stderr}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
