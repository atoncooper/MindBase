/**
 * Draft store - IndexedDB-backed unsaved-note drafts.
 *
 * Writes a draft before every save attempt and on tab-hide, so a crash or
 * navigation never loses in-flight typing. Cleared after a successful save.
 * SSR-safe (no-ops on server) and degrades silently if IndexedDB is unavailable
 * (private mode). Mirrors the frontend1 contract: key `note:${uuid}`.
 */
export interface NoteDraft {
    contentMd: string;
    title?: string;
    savedAt: number; // epoch ms
}

const DB_NAME = "mindbase-notes";
const DB_VERSION = 1;
const STORE = "drafts";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
    if (typeof window === "undefined") return Promise.resolve(null);
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
    return dbPromise;
}

function keyFor(noteUuid: string): string {
    return `note:${noteUuid}`;
}

export async function saveDraft(noteUuid: string, draft: NoteDraft): Promise<void> {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(draft, keyFor(noteUuid));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

export async function getDraft(noteUuid: string): Promise<NoteDraft | null> {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(keyFor(noteUuid));
        req.onsuccess = () => resolve((req.result as NoteDraft | undefined) ?? null);
        req.onerror = () => resolve(null);
    });
}

export async function clearDraft(noteUuid: string): Promise<void> {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(keyFor(noteUuid));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}
