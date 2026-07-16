"use client";

/**
 * IndexedDB draft store — offline buffer for note content.
 *
 * On every local edit we write the draft here. If the network fails or
 * the user closes the tab mid-edit, the next time they open the note we
 * detect a draft newer than the server's `updatedAt` and prompt:
 * "Recover unsaved draft?"
 *
 * Schema:
 *   key   = `note:${noteUuid}`
 *   value = { contentMd, title, savedAt (epoch ms) }
 */

const DB_NAME = "mindbase-notes";
const DB_VERSION = 1;
const STORE = "drafts";

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export interface NoteDraft {
    contentMd: string;
    title?: string;
    savedAt: number; // epoch ms
}

export async function saveDraft(noteUuid: string, draft: NoteDraft): Promise<void> {
    if (typeof window === "undefined") return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(draft, `note:${noteUuid}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch {
        // IndexedDB unavailable (private mode) — silently skip.
    }
}

export async function getDraft(noteUuid: string): Promise<NoteDraft | null> {
    if (typeof window === "undefined") return null;
    try {
        const db = await openDb();
        const result = await new Promise<NoteDraft | null>((resolve, reject) => {
            const tx = db.transaction(STORE, "readonly");
            const req = tx.objectStore(STORE).get(`note:${noteUuid}`);
            req.onsuccess = () => resolve((req.result as NoteDraft) ?? null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return result;
    } catch {
        return null;
    }
}

export async function clearDraft(noteUuid: string): Promise<void> {
    if (typeof window === "undefined") return;
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).delete(`note:${noteUuid}`);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch {
        // ignore
    }
}
