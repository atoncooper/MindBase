/**
 * 开发期 boards API mock（仅本地验证前端用，不进构建）。
 *
 * 用法：node scripts/mock-boards-server.mjs   （监听 127.0.0.1:9601）
 * 前端：NEXT_PUBLIC_API_URL=http://127.0.0.1:9601 npx next dev -p 3100
 *
 * 契约与 app-board 对齐：camelCase JSON、If-Match 版本乐观锁（冲突返回
 * 409 + detail 含 "version conflict"）、CORS 全开（dev 仅本机使用）。
 * 预置一张含长 Markdown / 长代码节点的导图，便于验证画布限高滚动。
 */

import http from "node:http";

const PORT = 9601;

/** 预置：一张带长 md 卡片 + 长代码卡片的导图。 */
function seedMindmapDoc() {
  const mdSource = [
    "## 系统设计要点",
    "",
    "这是一个**长 Markdown 卡片**：内容超过画布 420px 限高，",
    "应在卡片内部滚动，而不是把节点撑到无限高或把内容裁掉。",
    "",
    "### 小节一",
    "- 要点 A：捕获阶段拦截滚轮，避免触发画布缩放",
    "- 要点 B：测量与画布使用同一套限高样式",
    "- 要点 C：`overscroll-behavior: contain` 防止滚动穿透",
    "",
    "### 小节二",
    "1. 第一项",
    "2. 第二项",
    "3. 第三项",
    "",
    "> 引用块：Markdown 渲染与对话框预览同源。",
    "",
    "```js",
    "const x = 1 // 行内代码",
    "```",
    "",
    "| 列一 | 列二 |",
    "| ---- | ---- |",
    "| 甲   | 乙   |",
    "",
    "### 小节三",
    "结尾段落：滚到这里验证方向感知边界放行。",
  ].join("\n");

  const mdHtml = `<div class="smm-md-card"><h2>系统设计要点</h2><p>这是一个<strong>长 Markdown 卡片</strong>：内容超过画布 420px 限高，<br>应在卡片内部滚动，而不是把节点撑到无限高或把内容裁掉。</p><h3>小节一</h3><ul><li>要点 A：捕获阶段拦截滚轮，避免触发画布缩放</li><li>要点 B：测量与画布使用同一套限高样式</li><li>要点 C：<code>overscroll-behavior: contain</code> 防止滚动穿透</li></ul><h3>小节二</h3><ol><li>第一项</li><li>第二项</li><li>第三项</li></ol><blockquote><p>引用块：Markdown 渲染与对话框预览同源。</p></blockquote><div class="smm-md-pre"><code>const x = 1 // 行内代码</code></div><table><thead><tr><th>列一</th><th>列二</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table><h3>小节三</h3><p>结尾段落：滚到这里验证方向感知边界放行。</p></div>`;

  const code = [
    "import asyncio",
    "",
    "async def fetch_all(urls):",
    "    results = []",
    "    async with aiohttp.ClientSession() as session:",
    "        for url in urls:",
    "            async with session.get(url) as resp:",
    "                if resp.status == 200:",
    "                    results.append(await resp.json())",
    "                else:",
    "                    print(f\"skip {url}: {resp.status}\")",
    "    return results",
    "",
    "def main():",
    "    urls = [f\"https://example.com/item/{i}\" for i in range(64)]",
    "    data = asyncio.run(fetch_all(urls))",
    "    print(f\"fetched {len(data)} items\")",
    "",
    "if __name__ == \"__main__\":",
    "    main()",
  ].join("\n");

  const codeHtml = `<p class="smm-code-lang">python</p><div class="smm-code-scroll">${code
    .split("\n")
    .map((l) => `<p class="smm-code-line">${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("")}</div>`;

  return {
    root: {
      // smmVersion 挂在渲染树根上（getData(true) → getCopyData 的行为）；
      // 缺失会被当作旧版数据，触发 removeRichTextStyes 把卡片 HTML 压平。
      smmVersion: "0.14.0-fix.3",
      data: { text: "中心主题", uid: "seed-root" },
      children: [
        { data: { text: "普通节点（很长的一段文本，用来观察节点换行与选中效果）", uid: "seed-a" }, children: [] },
        {
          data: { text: mdHtml, richText: true, mdSource, customTextWidth: 460, uid: "seed-md" },
          children: [],
        },
        {
          data: { text: codeHtml, richText: true, customTextWidth: 420, uid: "seed-code" },
          children: [],
        },
      ],
    },
    layout: "logicalStructure",
  };
}

const boards = new Map();
let seq = 1;

function makeBoard(partial) {
  const now = new Date().toISOString();
  const board = {
    uuid: `seed-${String(seq++).padStart(3, "0")}`,
    title: "未命名导图",
    kind: "mindmap",
    version: 1,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    content: null,
    ...partial,
  };
  boards.set(board.uuid, board);
  return board;
}

makeBoard({ title: "演示导图（md/代码卡片）", content: JSON.stringify(seedMindmapDoc()) });
makeBoard({ title: "自由白板演示", kind: "whiteboard", content: null });

const corsHeaders = (req) => ({
  "Access-Control-Allow-Origin": req.headers.origin ?? "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,If-Match,X-Requested-With",
});

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}

function cors(res, req) {
  for (const [key, value] of Object.entries(corsHeaders(req))) res.setHeader(key, value);
}

function stripContent(board) {
  const { content, ...meta } = board;
  return meta;
}

const server = http.createServer((req, res) => {
  cors(res, req);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["board","boards",id?,action?]

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (parts[0] !== "board" || parts[1] !== "boards") {
    return json(res, 404, { detail: "not found" });
  }

  // 列表
  if (req.method === "GET" && parts.length === 2) {
    const kind = url.searchParams.get("kind");
    const items = [...boards.values()]
      .filter((b) => (kind ? b.kind === kind : true))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(stripContent);
    return json(res, 200, { items, total: items.length, page: 1, pageSize: 100 });
  }

  // 新建
  if (req.method === "POST" && parts.length === 2) {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      const board = makeBoard({
        title: parsed.title ?? "未命名导图",
        kind: parsed.kind ?? "mindmap",
        content: parsed.content ?? null,
      });
      return json(res, 200, board);
    });
  }

  const board = boards.get(decodeURIComponent(parts[2] ?? ""));
  if (!board) return json(res, 404, { detail: "board not found" });

  // 详情
  if (req.method === "GET" && parts.length === 3) {
    return json(res, 200, board);
  }

  // 置顶
  if (req.method === "PATCH" && parts[3] === "pin") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (Number(req.headers["if-match"]) !== board.version) {
        return json(res, 409, { detail: "version conflict" });
      }
      board.isPinned = Boolean(parsed.isPinned);
      board.version += 1;
      board.updatedAt = new Date().toISOString();
      return json(res, 200, board);
    });
  }

  // 更新
  if (req.method === "PUT" && parts.length === 3) {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      if (Number(req.headers["if-match"]) !== board.version) {
        return json(res, 409, { detail: "version conflict: board was modified elsewhere" });
      }
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.title === "string") board.title = parsed.title;
      if (typeof parsed.content === "string") board.content = parsed.content;
      board.version += 1;
      board.updatedAt = new Date().toISOString();
      return json(res, 200, board);
    });
  }

  // 删除
  if (req.method === "DELETE" && parts.length === 3) {
    boards.delete(board.uuid);
    return json(res, 200, {});
  }

  return json(res, 405, { detail: "method not allowed" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-boards] listening on http://127.0.0.1:${PORT}`);
});
