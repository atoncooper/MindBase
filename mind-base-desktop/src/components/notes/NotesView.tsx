/**
 * 笔记视图：左侧列表 + 右侧编辑面板。
 *
 * 保存策略：标题或内容变更 → 800ms 防抖自动保存；乐观并发——请求携带最后
 * 一次已知的 updatedAt，冲突时进入 conflict 状态并保留本地草稿不丢字。
 * 切换笔记 / 删除前强制 flush 未保存内容。
 *
 * 草稿模型：选中笔记后 detail 即权威数据，编辑只改 draft（title+content），
 * 保存成功后把服务端返回的 updatedAt 写回 detail 作为新的并发基线。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addAnchor,
  createNote,
  deleteAnchor,
  deleteNote,
  getNote,
  listNotes,
  listRevisions,
  restoreRevision,
  saveNote,
  togglePin,
} from "../../lib/notes";
import type { NoteDetail, NoteListRow, RevisionMeta } from "../../lib/notes";
import { toErrorMessage } from "../../lib/updater";
import type { PendingJump } from "../../lib/router";
import NoteListPane from "./NoteListPane";
import NoteEditorPane from "./NoteEditorPane";
import type { EditorMode, SaveStatus } from "./NoteEditorPane";

const AUTOSAVE_DEBOUNCE_MS = 800;

interface Draft {
  title: string;
  content: string;
}

interface NotesViewProps {
  /** 命令面板的跨视图跳转请求；本视图消费后经 onPendingConsumed 归零。 */
  pending: PendingJump | null;
  onPendingConsumed: () => void;
}

function NotesView({ pending, onPendingConsumed }: NotesViewProps): React.JSX.Element {
  const [notes, setNotes] = useState<NoteListRow[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [viewError, setViewError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionMeta[] | null>(null);

  /** Latest unsaved payload + its concurrency baseline. */
  const pendingRef = useRef<{ draft: Draft; expectedUpdatedAt: number } | null>(null);
  const debounceRef = useRef<number | null>(null);
  // 单飞闸：并发 flush 会用同一基线发两笔写，第二笔必被判冲突且基线
  // 无法前进，此后所有自动保存都会失败——所以同一时刻只允许一笔在途。
  const savingRef = useRef(false);

  const refreshList = useCallback(
    (q: string) => {
      void listNotes(q).then(setNotes, (err) => setViewError(toErrorMessage(err)));
    },
    [],
  );

  useEffect(() => {
    refreshList("");
  }, [refreshList]);

  // Debounced search over the local store.
  useEffect(() => {
    const timer = window.setTimeout(() => refreshList(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, refreshList]);

  function cancelPendingTimer(): void {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  async function flushSave(): Promise<void> {
    if (savingRef.current) return; // 在途写未落盘前不重入
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    cancelPendingTimer();
    if (detail === null || activeId === null) return;

    savingRef.current = true;
    setSaveStatus("saving");
    try {
      // One guarded write for title + body — saving them as two commands
      // would bump the baseline in between and fail every autosave.
      const result = await saveNote(
        activeId,
        pending.draft.title,
        pending.draft.content,
        pending.expectedUpdatedAt,
      );
      setDetail((prev) =>
        prev !== null
          ? { ...prev, ...pending.draft, updatedAt: result.updatedAt }
          : prev,
      );
      setSaveStatus("saved");
      refreshList(query);
    } catch (err) {
      const message = toErrorMessage(err);
      // Keep the local draft on any failure — never lose typed words.
      setSaveStatus(message.includes("别处被修改") ? "conflict" : "error");
      setViewError(message);
    } finally {
      savingRef.current = false;
    }
  }

  function editDraft(patch: Partial<Draft>): void {
    if (detail === null) return;
    const next: Draft = {
      title: patch.title ?? draft?.title ?? detail.title,
      content: patch.content ?? draft?.content ?? detail.content,
    };
    setDraft(next);
    setSaveStatus("dirty");
    pendingRef.current = { draft: next, expectedUpdatedAt: detail.updatedAt };
    cancelPendingTimer();
    debounceRef.current = window.setTimeout(() => void flushSave(), AUTOSAVE_DEBOUNCE_MS);
  }

  function runSelect(id: string): void {
    setActiveId(id);
    setDetail(null);
    setDraft(null);
    setSaveStatus("idle");
    setRevisionsOpen(false);
    setRevisions(null);
    void getNote(id).then(
      (fresh) => {
        setDetail(fresh);
        // draft 是编辑器的数据源；漏掉它会让渲染门槛永远卡在占位符。
        setDraft({ title: fresh.title, content: fresh.content });
        setSaveStatus("idle");
        pendingRef.current = null;
      },
      (err) => setViewError(toErrorMessage(err)),
    );
  }

  function selectNote(id: string): void {
    if (id === activeId) return;
    void flushSave().then(() => runSelect(id));
  }

  async function handleCreate(): Promise<void> {
    await flushSave();
    try {
      const created = await createNote();
      setNotes((prev) => [
        {
          id: created.id,
          title: created.title,
          pinned: created.pinned,
          updatedAt: created.updatedAt,
          charCount: 0,
          snippet: "",
        },
        ...prev,
      ]);
      setActiveId(created.id);
      setDetail(created);
      setDraft({ title: created.title, content: created.content });
      setSaveStatus("idle");
    } catch (err) {
      setViewError(toErrorMessage(err));
    }
  }

  // 命令面板的跨视图跳转：打开指定笔记 / 新建笔记，消费后归零。
  // 不属于本视图的 kind 原样放行（见 ChatView 同款注释）。
  useEffect(() => {
    if (pending === null) return;
    if (pending.kind !== "open-note" && pending.kind !== "new-note") return;
    if (pending.kind === "open-note" && pending.id !== "") {
      selectNote(pending.id);
    } else if (pending.kind === "new-note") {
      void handleCreate();
    }
    onPendingConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pending 变化即消费一次
  }, [pending]);

  async function handleDelete(id: string): Promise<void> {
    if (busyId !== "") return;
    if (id === activeId) await flushSave().catch(() => undefined);
    setBusyId(id);
    try {
      await deleteNote(id);
      setNotes((prev) => prev.filter((note) => note.id !== id));
      if (id === activeId) {
        setActiveId(null);
        setDetail(null);
        setDraft(null);
        setSaveStatus("idle");
      }
    } catch (err) {
      setViewError(toErrorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  async function handleTogglePin(id: string): Promise<void> {
    setBusyId(id);
    try {
      const result = await togglePin(id);
      setNotes((prev) =>
        prev.map((note) => (note.id === id ? { ...note, pinned: result.pinned } : note)),
      );
      if (id === activeId) {
        // Pin bumps updated_at server-side; adopt the returned value as the
        // new concurrency baseline or the next autosave would be rejected.
        setDetail((prev) =>
          prev !== null ? { ...prev, pinned: result.pinned, updatedAt: result.updatedAt } : prev,
        );
        pendingRef.current =
          pendingRef.current !== null
            ? { draft: pendingRef.current.draft, expectedUpdatedAt: result.updatedAt }
            : null;
      }
    } catch (err) {
      setViewError(toErrorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  async function handleAddAnchor(input: string): Promise<void> {
    if (activeId === null) return;
    try {
      const anchor = await addAnchor(activeId, input);
      setDetail((prev) => (prev !== null ? { ...prev, anchors: [...prev.anchors, anchor] } : prev));
    } catch (err) {
      setViewError(toErrorMessage(err));
    }
  }

  async function handleDeleteAnchor(anchorId: string): Promise<void> {
    try {
      await deleteAnchor(anchorId);
      setDetail((prev) =>
        prev !== null ? { ...prev, anchors: prev.anchors.filter((a) => a.id !== anchorId) } : prev,
      );
    } catch (err) {
      setViewError(toErrorMessage(err));
    }
  }

  function toggleRevisions(): void {
    const next = !revisionsOpen;
    setRevisionsOpen(next);
    if (next && activeId !== null) {
      setRevisions(null);
      void listRevisions(activeId).then(setRevisions, (err) => setViewError(toErrorMessage(err)));
    }
  }

  async function handleRestore(revisionId: string): Promise<void> {
    // Persist anything in flight first so the rollback starts from truth.
    await flushSave();
    try {
      await restoreRevision(revisionId);
      if (activeId !== null) {
        const fresh = await getNote(activeId);
        setDetail(fresh);
        setDraft({ title: fresh.title, content: fresh.content });
        setSaveStatus("saved");
        pendingRef.current = null;
        void listRevisions(activeId).then(setRevisions, () => undefined);
      }
      refreshList(query);
    } catch (err) {
      setViewError(toErrorMessage(err));
    }
  }

  return (
    <div className="notes-layout">
      <NoteListPane
        notes={notes}
        activeId={activeId}
        query={query}
        busyId={busyId}
        onQueryChange={setQuery}
        onSelect={selectNote}
        onCreate={() => void handleCreate()}
        onTogglePin={(id) => void handleTogglePin(id)}
        onDelete={(id) => void handleDelete(id)}
      />

      {detail === null || draft === null ? (
        <section className="card note-editor">
          <p className="placeholder">
            {viewError !== "" ? viewError : "选择或新建一篇笔记开始记录。"}
          </p>
        </section>
      ) : (
        <NoteEditorPane
          title={draft.title}
          content={draft.content}
          mode={mode}
          saveStatus={saveStatus}
          anchors={detail.anchors}
          pinned={detail.pinned}
          revisionsOpen={revisionsOpen}
          revisions={revisions}
          onSaveNow={() => void flushSave()}
          onTitleChange={(title) => editDraft({ title })}
          onContentChange={(content) => editDraft({ content })}
          onModeChange={setMode}
          onTogglePin={() => {
            if (activeId !== null) void handleTogglePin(activeId);
          }}
          onDelete={() => {
            if (activeId !== null) void handleDelete(activeId);
          }}
          onAddAnchor={(input) => void handleAddAnchor(input)}
          onDeleteAnchor={(anchorId) => void handleDeleteAnchor(anchorId)}
          onToggleRevisions={toggleRevisions}
          onRestoreRevision={(revisionId) => void handleRestore(revisionId)}
        />
      )}
    </div>
  );
}

export default NotesView;
