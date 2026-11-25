/**
 * Email HTML renderer for AI task reports.
 *
 * The agent emits GitHub-flavored Markdown (headings, lists, links, tables,
 * code blocks). Email clients do not render Markdown, so convert the common
 * subset to safe inline-styled HTML here. This intentionally avoids a DOM
 * dependency and never trusts raw HTML from the model.
 */

const EMAIL_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
const CODE_FONT = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace';

export interface TaskEmailInput {
  title: string;
  status: "succeeded" | "failed" | "cancelled";
  when: string;
  content: string;
  error?: string;
}

export function renderTaskEmail(input: TaskEmailInput): string {
  const ok = input.status === "succeeded";
  const cancelled = input.status === "cancelled";
  const state = ok ? "已完成" : cancelled ? "已取消" : "执行失败";
  const accent = ok ? "#1a7f37" : cancelled ? "#6e6e73" : "#c62828";
  const stateBg = ok ? "#eaf7ee" : cancelled ? "#f0f0f2" : "#fdecec";
  const body = input.content.trim()
    ? markdownToEmailHtml(input.content.slice(0, 40_000))
    : `<div style="border:1px solid #f0c7c7;background:#fff7f7;border-radius:8px;padding:14px;color:#8a1f1f;font-size:14px">${escapeHtml(input.error ?? "本次运行没有生成可用报告。")}</div>`;

  return `<div style="margin:0;padding:24px 0;background:#f5f5f7;font-family:${EMAIL_FONT};color:#1d1d1f">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e7;border-radius:12px;overflow:hidden">
    <div style="padding:22px 28px 18px;background:#fbfbfd;border-bottom:1px solid #ececef">
      <div style="font-size:11px;letter-spacing:.08em;color:#86868b;text-transform:uppercase">MindBase · AI 定时任务</div>
      <h1 style="margin:8px 0 0;font-size:21px;line-height:1.35;font-weight:600;color:#1d1d1f">${escapeHtml(input.title)}</h1>
      <div style="margin-top:8px;font-size:13px;color:#6e6e73">${escapeHtml(input.when)}</div>
      <span style="display:inline-block;margin-top:10px;padding:3px 9px;border-radius:999px;background:${stateBg};color:${accent};font-size:12px;font-weight:600">${state}</span>
    </div>
    <div style="padding:24px 28px;font-size:15px;line-height:1.7;color:#1d1d1f">${body}</div>
    <div style="padding:16px 28px;background:#fbfbfd;border-top:1px solid #ececef;color:#8a8a8f;font-size:12px;line-height:1.6">
      这封邮件由 MindBase「AI 定时任务」自动发送。登录 MindBase，在「对话 → AI 定时任务」中查看完整报告和运行记录。
    </div>
  </div>
</div>`;
}

/** Convert a safe subset of Markdown to inline-styled email HTML. */
export function markdownToEmailHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p style="margin:0 0 14px;line-height:1.72">${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) {
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(`<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid #d2d2d7;background:#fafafa;color:#55555a;border-radius:0 8px 8px 0">${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const closeOpenBlocks = () => {
    flushParagraph();
    closeList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      flushQuote();
      continue;
    }

    // Fenced code block.
    if (/^\s*```/.test(line)) {
      closeOpenBlocks();
      const language = line.replace(/^\s*```/, "").trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(
        `<div style="margin:0 0 16px;border:1px solid #e1e4e8;border-radius:8px;overflow:hidden;background:#0f1115">` +
          (language ? `<div style="padding:6px 12px;background:#151922;color:#8b949e;font-size:11px;font-family:${CODE_FONT}">${escapeHtml(language)}</div>` : "") +
          `<pre style="margin:0;padding:12px 14px;overflow-x:auto;color:#c9d1d9;font-size:12.5px;line-height:1.6;font-family:${CODE_FONT}"><code style="font-family:inherit">${escapeHtml(code.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeOpenBlocks();
      const level = Math.min(heading[1].length, 4);
      const sizes = ["22px", "18px", "16px", "15px"];
      out.push(`<h${level} style="margin:22px 0 10px;font-size:${sizes[level - 1]};line-height:1.4;font-weight:600;color:#1d1d1f">${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeOpenBlocks();
      out.push('<hr style="border:0;border-top:1px solid #e5e5e7;margin:20px 0" />');
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();

    // GFM table: header row + separator row.
    if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
      closeOpenBlocks();
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push(renderTable(header, rows));
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const type = bullet ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        listType = type;
        out.push(type === "ul" ? '<ul style="margin:0 0 14px;padding-left:22px">' : '<ol style="margin:0 0 14px;padding-left:24px">');
      }
      out.push(`<li style="margin:4px 0;line-height:1.65">${inline((bullet ?? ordered)![1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }

  closeOpenBlocks();
  return out.join("\n");
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().split("|").length >= 2;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderTable(header: string[], rows: string[][]): string {
  const head = header.map((cell) => `<th style="padding:9px 12px;border-bottom:1px solid #d2d2d7;background:#f7f7f8;text-align:left;font-size:12.5px;font-weight:600;color:#1d1d1f">${inline(cell)}</th>`).join("");
  const body = rows.map((row) => {
    const cells = header.map((_, index) => `<td style="padding:9px 12px;border-bottom:1px solid #ececef;text-align:left;font-size:12.5px;color:#424245;vertical-align:top">${inline(row[index] ?? "")}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div style="margin:0 0 16px;overflow-x:auto"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e5e7;border-radius:8px;overflow:hidden;font-family:${EMAIL_FONT}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Escape first, then apply a deliberately small Markdown inline grammar. */
function inline(value: string): string {
  let text = escapeHtml(value);
  const code: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, content: string) => {
    const token = `@@CODE${code.length}@@`;
    code.push(`<code style="padding:1px 5px;border-radius:4px;background:#f1f1f3;border:1px solid #e7e7ea;font-family:${CODE_FONT};font-size:12px">${content}</code>`);
    return token;
  });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    const safeUrl = escapeAttribute(url);
    return `<a href="${safeUrl}" style="color:#0066cc;text-decoration:underline;text-underline-offset:2px">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong style="font-weight:600">$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong style="font-weight:600">$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<span style="text-decoration:line-through">$1</span>');
  return text.replace(/@@CODE(\d+)@@/g, (_, index: string) => code[Number(index)] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  // The value is already HTML-escaped by inline(); only encode characters that
  // could break out of the attribute. Do not re-escape "&" (would turn &amp; into
  // &amp;amp; and corrupt query strings).
  return value
    .replace(/"/g, "%22")
    .replace(/'/g, "%27")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/`/g, "%60");
}
