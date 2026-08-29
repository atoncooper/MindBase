/**
 * Ctrl+K 全局命令面板：跨会话 / 笔记 / 文档 / 技能的统一搜索与跳转。
 *
 * 数据在每次打开时并行拉取（本地数据量级下全量拉取 + 内存过滤即可，
 * 无需 Rust 端 FTS）；动作条目常驻。键盘：↑↓ 循环、Enter 执行、
 * Esc 关闭。选中后经 `onJump` 上抛——纯导航类直接切 hash，会话 / 笔记
 * 类由 App 转为 pending prop 交给目标视图消费。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FAVORITES_HASH,
  HOME_HASH,
  IMPORT_HASH,
  KNOWLEDGE_HASH,
  NOTES_HASH,
  SETTINGS_API_HASH,
  SETTINGS_SYSTEM_HASH,
  SKILLS_HASH,
} from "../lib/router";
import type { PendingJump } from "../lib/router";
import { listSessions } from "../lib/chat";
import { listNotes } from "../lib/notes";
import { listDocuments } from "../lib/ingest";
import { listSkills } from "../lib/skills";

/** One searchable entry: group header + display text + the jump it performs. */
interface PaletteEntry {
  group: string;
  title: string;
  subtitle: string;
  hash: string;
  jump: PendingJump;
}

const GROUP_ORDER = ["动作", "会话", "笔记", "文档", "技能"];

/** Static action entries — always available regardless of loaded data. */
function actionEntries(): PaletteEntry[] {
  return [
    { group: "动作", title: "新建对话", subtitle: "开始一段新的知识库问答", hash: HOME_HASH, jump: { kind: "new-session" } },
    { group: "动作", title: "新建笔记", subtitle: "创建一篇空白笔记", hash: NOTES_HASH, jump: { kind: "new-note" } },
    { group: "动作", title: "打开技能管理", subtitle: "商店安装 / 本地技能配置", hash: SKILLS_HASH, jump: { kind: "view", hash: SKILLS_HASH } },
    { group: "动作", title: "打开知识库", subtitle: "文档入库与向量管理", hash: KNOWLEDGE_HASH, jump: { kind: "view", hash: KNOWLEDGE_HASH } },
    { group: "动作", title: "文件入库", subtitle: "导入本机文档 / 文件夹构建知识库", hash: IMPORT_HASH, jump: { kind: "view", hash: IMPORT_HASH } },
    { group: "动作", title: "打开收藏夹", subtitle: "B 站收藏夹浏览与同步", hash: FAVORITES_HASH, jump: { kind: "view", hash: FAVORITES_HASH } },
    { group: "动作", title: "打开系统设置", subtitle: "数据目录 / 存储状态", hash: SETTINGS_SYSTEM_HASH, jump: { kind: "view", hash: SETTINGS_SYSTEM_HASH } },
    { group: "动作", title: "打开 API 设置", subtitle: "对话 / ASR / 向量化密钥", hash: SETTINGS_API_HASH, jump: { kind: "view", hash: SETTINGS_API_HASH } },
  ];
}

function matches(entry: PaletteEntry, query: string): boolean {
  if (query === "") return true;
  return (
    entry.title.toLowerCase().includes(query) ||
    entry.subtitle.toLowerCase().includes(query)
  );
}

function query_norm(query: string): string {
  return query.trim().toLowerCase();
}

interface CommandPaletteProps {
  onClose: () => void;
  onJump: (jump: PendingJump, hash: string) => void;
}

function CommandPalette({ onClose, onJump }: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [sessions, setSessions] = useState<PaletteEntry[]>([]);
  const [notes, setNotes] = useState<PaletteEntry[]>([]);
  const [documents, setDocuments] = useState<PaletteEntry[]>([]);
  const [skills, setSkills] = useState<PaletteEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // Open 时并行拉取全部数据源；单个失败不影响其余分组。
  useEffect(() => {
    void listSessions().then(
      (rows) =>
        setSessions(
          rows.map((row) => ({
            group: "会话",
            title: row.title,
            subtitle: "对话会话",
            hash: HOME_HASH,
            jump: { kind: "open-session", id: row.chatSessionId },
          })),
        ),
      () => undefined,
    );
    void listNotes().then(
      (rows) =>
        setNotes(
          rows.map((row) => ({
            group: "笔记",
            title: row.title,
            subtitle: row.snippet === "" ? "笔记" : row.snippet,
            hash: NOTES_HASH,
            jump: { kind: "open-note", id: row.id },
          })),
        ),
      () => undefined,
    );
    void listDocuments().then(
      (rows) =>
        setDocuments(
          rows.map((row) => ({
            group: "文档",
            title: row.pageTitle === "" ? row.videoTitle : `${row.videoTitle} · ${row.pageTitle}`,
            subtitle: `知识库文档 · ${row.source}`,
            hash: KNOWLEDGE_HASH,
            jump: { kind: "view", hash: KNOWLEDGE_HASH },
          })),
        ),
      () => undefined,
    );
    void listSkills().then(
      (rows) =>
        setSkills(
          rows.map((row) => ({
            group: "技能",
            title: `/${row.name}`,
            subtitle: row.description === "" ? (row.enabled ? "技能" : "技能（已停用）") : row.description,
            hash: SKILLS_HASH,
            jump: { kind: "view", hash: SKILLS_HASH },
          })),
        ),
      () => undefined,
    );
  }, []);

  // 过滤 + 分组排序 + 每组截断，输出扁平列表供键盘导航。
  const entries = useMemo(() => {
    const normalized = query_norm(query);
    const pools = [actionEntries(), sessions, notes, documents, skills];
    const flat: PaletteEntry[] = [];
    for (const group of GROUP_ORDER) {
      const pool = pools.find((p) => p[0]?.group === group) ?? [];
      let taken = 0;
      for (const entry of pool) {
        if (taken >= 6) break;
        if (matches(entry, normalized)) {
          flat.push(entry);
          taken += 1;
        }
      }
    }
    return flat;
  }, [query, sessions, notes, documents, skills]);

  // 过滤结果变化时高亮回到首位。
  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    // 高亮项滚入可视区。
    const node = listRef.current?.querySelector(".palette__item.is-active");
    node?.scrollIntoView({ block: "nearest" });
  }, [index, entries]);

  function execute(entry: PaletteEntry): void {
    onJump(entry.jump, entry.hash);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((prev) => (entries.length === 0 ? 0 : (prev + 1) % entries.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((prev) => (entries.length === 0 ? 0 : (prev - 1 + entries.length) % entries.length));
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = entries[index];
      if (picked !== undefined) execute(picked);
    }
  }

  let renderedGroup = "";

  return (
    <div
      className="palette-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="text"
          className="palette__input"
          placeholder="搜索会话、笔记、文档、技能，或执行动作…"
          value={query}
          autoFocus
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="palette__list" ref={listRef}>
          {entries.length === 0 ? (
            <p className="palette__empty">没有匹配项</p>
          ) : (
            entries.map((entry, i) => {
              const showGroup = entry.group !== renderedGroup;
              renderedGroup = entry.group;
              return (
                <div key={`${entry.group}-${entry.title}-${i}`}>
                  {showGroup && <p className="palette__group">{entry.group}</p>}
                  <button
                    type="button"
                    className={i === index ? "palette__item is-active" : "palette__item"}
                    aria-selected={i === index}
                    role="option"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => execute(entry)}
                  >
                    <span className="palette__item-title">{entry.title}</span>
                    <span className="palette__item-sub">{entry.subtitle}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>
        <p className="palette__foot">
          ↑↓ 导航 · Enter 执行 · Esc 关闭
        </p>
      </div>
    </div>
  );
}

export default CommandPalette;
