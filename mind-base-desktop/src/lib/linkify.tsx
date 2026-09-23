/**
 * 纯文本超链接化：识别 http(s)://、www.*、常见顶级域的裸域名，以及
 * Windows/Unix 绝对路径，把它们变成可点击链接（http/域名经 openUrl 用系统
 * 浏览器打开，本地路径经 openPath 用系统默认程序/资源管理器打开）。
 *
 * 两个使用面：
 * - `LinkifiedText`：React 纯文本渲染（用户消息气泡等不走 Markdown 的位置）；
 * - `remarkLinkify`：mdast transform——共享 Markdown 渲染器挂上它之后，
 *   正文里手打的网址/路径也出链接（GFM autolink literal 只认 http(s)://
 *   与 www.*，认不了裸域名和盘符路径）。
 *
 * 保守匹配：域名走 TLD 白名单，路径必须「盘符 + 分隔符 + 至少一段目录名」，
 * 避免把「Node.js」「3.14」之类误判成链接。
 */

import { openPath, openUrl } from "@tauri-apps/plugin-opener";

/** URL 内部不允许出现的字符（空白、尖括号、常用中文标点、竖线）。 */
const TAIL = "[^\\s<>「」『』【】（））《》\"'，。；：！？、|]+";

/** 每次调用新建实例，避免共享 lastIndex 状态。 */
function makePattern(): RegExp {
  return new RegExp(
    [
      `https?:\\/\\/${TAIL}`,
      `www\\.${TAIL}`,
      `(?<![A-Za-z0-9@.\\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:com|cn|net|org|io|dev|ai|app|xyz|me|tv|cc|co|edu|gov)(?:\\/${TAIL})?`,
      `(?<![A-Za-z0-9\\\\/])(?:[A-Za-z]:[\\\\/](?:[^\\s\\\\/:*?"<>|，。；：！？、]+[\\\\/])*[^\\s\\\\/:*?"<>|，。；：！？、]+)`,
    ].join("|"),
    "gi",
  );
}

/** 一次匹配 → 规范化的链接目标；不能成为链接时返回 null。 */
interface ResolvedLink {
  href: string;
  display: string;
}

function resolveMatch(raw: string): ResolvedLink | null {
  // 先剥掉黏在链接尾部的句读（右括号与全角右括号单独走括号平衡处理）。
  let display = raw.replace(/[.,;:!?…】」』"']+$/, "");
  // 不配对的收尾右括号剥到配平：括号里没有未闭合的 ( 才保留）。
  while (display.endsWith(")") || display.endsWith("）")) {
    const close = display.slice(-1);
    const open = close === ")" ? "(" : "（";
    const opens = (display.match(new RegExp(`\\${open}`, "g")) ?? []).length;
    const closes = (display.match(new RegExp(`\\${close}`, "g")) ?? []).length;
    if (opens >= closes) break; // 括号配对完整，保留
    display = display.slice(0, -1);
  }
  if (display.length < 4) return null;
  if (/^https?:\/\//i.test(display)) return { href: display, display };
  if (/^www\./i.test(display)) return { href: `https://${display}`, display };
  if (/^[A-Za-z]:[\\/]/.test(display)) return { href: display, display };
  // 其余（裸域名/裸域名+路径）：补 https:// 再打开。
  if (/\.[a-z]{2,}(?:\/|$)/i.test(display)) return { href: `https://${display}`, display };
  return null;
}

/** 纯文本 → text/link 分段（供 remark transform 与 React 渲染共用）。 */
export interface LinkToken {
  kind: "text" | "link";
  value: string;
  /** kind === "link" 时有效。 */
  href?: string;
}

export function splitLinkTokens(text: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  const pattern = makePattern();
  let last = 0;
  let found = false;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const link = resolveLinkToken(match[0]);
    if (link === null) continue;
    if (index > last) tokens.push({ kind: "text", value: text.slice(last, index) });
    tokens.push(link);
    // 只消费链接本体（剥掉的尾部标点留给下一段正文）。
    last = index + link.value.length;
    found = true;
  }
  if (!found) return [{ kind: "text", value: text }];
  if (last < text.length) tokens.push({ kind: "text", value: text.slice(last) });
  return tokens;
}

function resolveLinkToken(raw: string): LinkToken | null {
  const link = resolveMatch(raw);
  if (link === null) return null;
  return { kind: "link", value: link.display, href: link.href };
}

/** 点击行为：http(s) 走系统浏览器，其余按本地路径打开；失败静默（不打断）。 */
export function openResolvedLink(href: string): void {
  if (/^https?:/i.test(href)) void openUrl(href).catch(() => undefined);
  else void openPath(href).catch(() => undefined);
}

/** React 纯文本链接化（用户消息气泡等）。 */
export function LinkifiedText({ text }: { text: string }): React.JSX.Element {
  const tokens = splitLinkTokens(text);
  if (tokens.length === 1 && tokens[0].kind === "text") return <>{text}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.kind === "text" ? (
          <span key={index}>{token.value}</span>
        ) : (
          <a
            key={index}
            className="text-link"
            href={token.href}
            onClick={(event) => {
              event.preventDefault();
              if (token.href !== undefined) openResolvedLink(token.href);
            }}
          >
            {token.value}
          </a>
        ),
      )}
    </>
  );
}

/* ── mdast transform（remark 插件，无第三方依赖）────────────────────── */

/** 本插件只关心的 mdast 节点结构（最小化类型）。 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** 代码与已有链接不再向内链接化（避免破坏代码语义 / 嵌套链接）。 */
const LINKIFY_SKIP = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

function textToMdNodes(text: string): MdNode[] | null {
  const tokens = splitLinkTokens(text);
  if (tokens.length === 1 && tokens[0].kind === "text") return null;
  return tokens.map((token) =>
    token.kind === "text"
      ? { type: "text", value: token.value }
      : {
          type: "link",
          url: token.href ?? "",
          children: [{ type: "text", value: token.value }],
        },
  );
}

function walkMdNode(node: MdNode): void {
  if (node.children === undefined) return;
  const next: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const pieces = textToMdNodes(child.value);
      if (pieces !== null) {
        next.push(...pieces);
        changed = true;
        continue;
      }
    }
    if (!LINKIFY_SKIP.has(child.type)) walkMdNode(child);
    next.push(child);
  }
  if (changed) node.children = next;
}

/** remark 插件：把正文 text 节点里的网址/路径拆成 link 节点。 */
export function remarkLinkify(): (tree: MdNode) => void {
  return (tree) => {
    walkMdNode(tree);
  };
}
