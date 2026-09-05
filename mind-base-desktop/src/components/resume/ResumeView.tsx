/**
 * 简历生成页（#/resume）：从全量聊天历史提炼素材，生成 Markdown 简历。
 *
 * 聊得越久素材越多，简历越详细。生成是 map-reduce 长任务（历史分段逐段
 * 提炼），进度经 Channel 事件展示；完成后可「保存为笔记」或「导出 .md」。
 */

import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { MarkdownContent } from "../chat/MarkdownContent";
import { exportTextFile, generateResume } from "../../lib/resume";
import type { ResumeGenEvent } from "../../lib/resume";
import { createNote, saveNote } from "../../lib/notes";
import { navigate, NOTES_HASH } from "../../lib/router";
import { toErrorMessage } from "../../lib/updater";
import { useToast } from "../../lib/toast";

type Phase = "idle" | "generating" | "done";

function ResumeView(): React.JSX.Element {
  const [targetRole, setTargetRole] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function generate(): Promise<void> {
    setError("");
    setMarkdown("");
    setPhase("generating");
    setStage("正在收集聊天历史…");
    try {
      const result = await generateResume(
        { targetRole: targetRole.trim() || undefined },
        (event: ResumeGenEvent) => {
          if (event.type === "collecting") {
            setStage(`已收集 ${event.messages} 条对话消息`);
          } else if (event.type === "extracting") {
            setStage(`提炼素材（${event.index + 1}/${event.total} 段）…`);
          } else if (event.type === "writing") {
            setStage("正在撰写简历…");
          }
        },
      );
      setMarkdown(result);
      setPhase("done");
    } catch (err) {
      setError(toErrorMessage(err));
      setPhase("idle");
    }
  }

  async function saveAsNote(): Promise<void> {
    if (markdown === "") return;
    setSaving(true);
    try {
      const heading = /^#\s+(.+)$/m.exec(markdown);
      const title = heading?.[1]?.trim() || "我的简历";
      const note = await createNote(title);
      await saveNote(note.id, title, markdown, note.updatedAt);
      toast.success("已保存到笔记，可在笔记页继续编辑", { title: "已保存" });
      navigate(NOTES_HASH);
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  async function exportMarkdown(): Promise<void> {
    if (markdown === "") return;
    try {
      const path = await save({
        title: "导出简历",
        defaultPath: "我的简历.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (path === null) return;
      await exportTextFile(path, markdown);
      toast.success(`已导出到 ${path}`, { title: "已导出" });
    } catch (err) {
      toast.error(toErrorMessage(err), { title: "导出失败" });
    }
  }

  return (
    <>
      <section className="card quiz-pane">
        <h2 className="card__title">
          <span className="card__index">RM</span>简历生成
        </h2>
        <p className="hint-text">
          基于你的<b>全部历史对话</b>提炼技能、项目与经历，生成 Markdown
          简历。和助手聊得越久，素材越多，简历越详细；生成后可存为笔记继续润色。
        </p>

        <div className="cfg-row">
          <span className="cfg-label">求职方向</span>
          <input
            type="text"
            className="cfg-input"
            placeholder="可选：如「前端工程师」「算法实习生」"
            value={targetRole}
            disabled={phase === "generating"}
            onChange={(event) => setTargetRole(event.target.value)}
          />
        </div>

        {error !== "" && <p className="error-text">{error}</p>}
        <div className="card__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={phase === "generating"}
            onClick={() => void generate()}
          >
            {phase === "generating" ? (
              <>
                <span className="ingest__spinner" />
                {stage !== "" ? stage : "生成中…"}
              </>
            ) : markdown !== "" ? (
              "重新生成"
            ) : (
              "从聊天历史生成"
            )}
          </button>
        </div>
      </section>

      {phase === "done" && markdown !== "" && (
        <section className="card">
          <h2 className="card__title">
            <span className="card__index">✓</span>生成结果
            <span className="ws-doc__page-actions">
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => void saveAsNote()}
              >
                保存为笔记
              </button>
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => void exportMarkdown()}
              >
                导出 .md
              </button>
            </span>
          </h2>
          <MarkdownContent content={markdown} />
        </section>
      )}
    </>
  );
}

export default ResumeView;
