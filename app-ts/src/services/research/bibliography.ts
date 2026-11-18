import type { AcademicCitationStyle, AcademicLiteratureEntry } from "../../repository/academic.js";
import { formatBibliography } from "./citation-format.js";

/** 参考文献段落标题（导出时用于避免重复追加）。 */
export const REFERENCES_TITLE = "参考文献";

/** 按项目引用风格渲染参考文献行；无文献时返回空数组。 */
export function bibliographyLines(
  entries: AcademicLiteratureEntry[],
  style: AcademicCitationStyle | undefined,
): string[] {
  if (entries.length === 0) return [];
  const text = formatBibliography(entries, style ?? "plain");
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Markdown 追加参考文献章节；已有同名章节时不重复追加。 */
export function appendMarkdownReferences(
  markdown: string,
  entries: AcademicLiteratureEntry[],
  style: AcademicCitationStyle | undefined,
): string {
  if (markdown.includes("## " + REFERENCES_TITLE) || markdown.includes("# " + REFERENCES_TITLE)) return markdown;
  const lines = bibliographyLines(entries, style);
  if (lines.length === 0) return markdown;
  return markdown.trimEnd() + "\n\n## " + REFERENCES_TITLE + "\n\n" + lines.join("\n\n") + "\n";
}

/** LaTeX 追加参考文献；escape 由调用方提供（避免把引用文本当成 LaTeX 命令）。 */
export function appendLatexReferences(
  latex: string,
  entries: AcademicLiteratureEntry[],
  style: AcademicCitationStyle | undefined,
  escape: (text: string) => string,
): string {
  if (latex.includes("\\section*{" + REFERENCES_TITLE + "}")) return latex;
  const lines = bibliographyLines(entries, style);
  if (lines.length === 0) return latex;
  const block = [
    "",
    "\\section*{" + REFERENCES_TITLE + "}",
    ...lines.map((line) => escape(line) + "\\par"),
    "",
  ].join("\n");
  if (latex.includes("\\end{document}")) return latex.replace("\\end{document}", block + "\\end{document}");
  return latex + block;
}

/** Word 导出用的参考文献章节；已有同名章节或没有文献时返回 null。 */
export function referencesDocxSection(
  entries: AcademicLiteratureEntry[],
  style: AcademicCitationStyle | undefined,
  existingTitles: string[],
): { title: string; content: string } | null {
  if (existingTitles.some((title) => title.trim() === REFERENCES_TITLE)) return null;
  const lines = bibliographyLines(entries, style);
  if (lines.length === 0) return null;
  return { title: REFERENCES_TITLE, content: lines.join("\n") };
}
