import { describe, expect, it } from "vitest";
import { markdownToEmailHtml, renderTaskEmail } from "../src/services/tasks/email-html.js";

describe("AI task email HTML", () => {
  it("renders headings, lists, tables, links and code", () => {
    const html = markdownToEmailHtml([
      "# 标题",
      "",
      "**重点** 和 [链接](https://example.com)",
      "",
      "- 第一项",
      "- 第二项",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "```python",
      "print(1)",
      "```",
    ].join("\n"));
    expect(html).toContain("<h1");
    expect(html).toContain("<strong");
    expect(html).toContain("<a href=\"https://example.com\"");
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("<pre");
  });

  it("escapes raw HTML and renders the email shell", () => {
    const html = renderTaskEmail({
      title: "测试 <script>",
      status: "succeeded",
      when: "2026-11-23 09:00",
      content: "## 摘要\n\n<script>alert(1)</script>",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("MindBase · AI 定时任务");
  });
});
