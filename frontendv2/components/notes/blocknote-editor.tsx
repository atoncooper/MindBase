"use client";

/**
 * BlockNote wrapper for the notes editor (Notion-style WYSIWYG).
 *
 * Markdown stays the canonical storage format: the initial content is parsed
 * once, edits are converted back with blocksToMarkdownLossy (debounced), and
 * the parent keeps autosave/draft logic unchanged. The same editor also feeds
 * the live outline panel (heading blocks) and exposes a scroll-to-block handle.
 *
 * Imported with next/dynamic({ ssr: false }) because BlockNote/ProseMirror are
 * DOM-only.
 */

import { useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { zh } from "@blocknote/core/locales";

export interface OutlineItem {
    id: string;
    level: number;
    text: string;
}

export interface BlockNoteHandle {
    scrollToBlock: (id: string) => void;
}

interface BlockNoteMarkdownEditorProps {
    initialMarkdown: string;
    onChange: (markdown: string) => void;
    onOutlineChange?: (items: OutlineItem[]) => void;
    onReady?: (handle: BlockNoteHandle | null) => void;
    editable?: boolean;
}

// Inline text of a block (plain text runs + nested link content).
function inlineText(nodes: unknown): string {
    if (!Array.isArray(nodes)) return "";
    return nodes
        .map((node) => {
            if (!node || typeof node !== "object") return "";
            const n = node as { text?: unknown; content?: unknown };
            if (typeof n.text === "string") return n.text;
            return inlineText(n.content);
        })
        .join("");
}

function collectOutline(editor: ReturnType<typeof useCreateBlockNote>): OutlineItem[] {
    const items: OutlineItem[] = [];
    for (const block of editor.document) {
        if (block.type !== "heading") continue;
        const level = Number((block.props as { level?: unknown })?.level ?? 1);
        if (!Number.isFinite(level) || level < 1 || level > 3) continue;
        const text = inlineText(block.content).trim();
        if (text) items.push({ id: block.id, level, text });
    }
    return items;
}

export function BlockNoteMarkdownEditor({
    initialMarkdown,
    onChange,
    onOutlineChange,
    onReady,
    editable = true,
}: BlockNoteMarkdownEditorProps) {
    // Chinese menus/tooltips to match the rest of the product.
    const editor = useCreateBlockNote({ dictionary: zh });
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestOnChange = useRef(onChange);
    latestOnChange.current = onChange;
    const latestOutline = useRef(onOutlineChange);
    latestOutline.current = onOutlineChange;
    // Hydration / dirty guards: parsing the stored Markdown fires BlockNote's
    // onChange, which must not look like a user edit (otherwise merely opening
    // a note would normalize + autosave it).
    const hydrated = useRef(false);
    const dirty = useRef(false);

    const emitOutline = () => {
        try {
            latestOutline.current?.(collectOutline(editor));
        } catch {
            /* outline is best-effort */
        }
    };

    // Parse the stored Markdown once per mount (note switch / draft restore
    // remounts this component, so no in-place reset is needed).
    useEffect(() => {
        if (!initialMarkdown.trim()) {
            hydrated.current = true;
            emitOutline();
            return;
        }
        let cancelled = false;
        try {
            const blocks = editor.tryParseMarkdownToBlocks(initialMarkdown);
            if (!cancelled && blocks.length > 0) {
                editor.replaceBlocks(editor.document, blocks);
            }
        } catch {
            // Unparseable legacy Markdown: keep the empty document rather than
            // dropping the user into a broken editor.
        }
        emitOutline();
        // The replace emits onChange synchronously or on the next tick; mark
        // hydrated only afterwards so that emission is ignored.
        const handle = setTimeout(() => {
            hydrated.current = true;
        }, 50);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot seed; later prop changes are user edits flowing OUT, not resets
    }, [editor]);

    // Expose the scroll-to-block handle used by the outline panel.
    useEffect(() => {
        const handle: BlockNoteHandle = {
            scrollToBlock: (id: string) => {
                const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
                if (el instanceof HTMLElement) {
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                    return;
                }
                // Defensive fallback (custom block DOM): put the cursor there.
                const block = editor.getBlock(id);
                if (block) editor.setTextCursorPosition(block, "start");
            },
        };
        onReady?.(handle);
        return () => onReady?.(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editor]);

    // Debounce blocks -> Markdown so we do not serialize the whole document on
    // every keystroke; 200ms keeps autosave (1.5s) well fed.
    const scheduleChange = () => {
        if (!hydrated.current) return;
        dirty.current = true;
        emitOutline();
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            try {
                latestOnChange.current(editor.blocksToMarkdownLossy(editor.document));
                dirty.current = false;
            } catch {
                // Conversion failure must not break typing; the next edit retries.
            }
        }, 200);
    };

    // Flush the trailing conversion on unmount so a quick note switch does not
    // lose the last 200ms of edits.
    useEffect(() => {
        return () => {
            if (timer.current !== null) {
                clearTimeout(timer.current);
                timer.current = null;
            }
            if (dirty.current) {
                try {
                    latestOnChange.current(editor.blocksToMarkdownLossy(editor.document));
                } catch {
                    /* ignore */
                }
            }
        };
    }, [editor]);

    return (
        <BlockNoteView
            editor={editor}
            editable={editable}
            theme="light"
            onChange={scheduleChange}
        />
    );
}
