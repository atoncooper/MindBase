/** Normalize any rejected value into a readable message (web shim for the
 * desktop lib/updater helper — no update-check semantics needed here). */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}
