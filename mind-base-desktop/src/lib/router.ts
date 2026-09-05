/**
 * Minimal hash router: home (chat workspace) / knowledge / favorites / the
 * two settings groups.
 *
 * Routes:
 * - `#/`                     → home, the chat workspace
 * - `#/knowledge`            → knowledge base (search + document management)
 * - `#/import`               → local file ingestion (文件入库)
 * - `#/favorites`            → favorites browsing (main area)
 * - `#/skills`               → skill manager (store install + installed list)
 * - `#/quiz`                 → quiz config + generation + set history
 * - `#/quiz/set/:id`         → one persisted quiz set (view / answer / answers toggle)
 * - `#/settings/system`      → settings, 系统设置 tab
 * - `#/settings/api`         → settings, API 设置 tab
 *
 * Anything unparsable degrades to home — a desktop app must never blank out
 * because of a stale hash.
 */

import { useEffect, useState } from "react";

export type SettingsTab = "system" | "api";

export type Route =
  | { view: "home" }
  | { view: "notes" }
  | { view: "quiz" }
  | { view: "quiz-set"; setId: string }
  | { view: "resume" }
  | { view: "slides" }
  | { view: "knowledge" }
  | { view: "import" }
  | { view: "favorites" }
  | { view: "skills" }
  | { view: "settings"; tab: SettingsTab };

export const HOME_HASH = "#/";
export const NOTES_HASH = "#/notes";
export const QUIZ_HASH = "#/quiz";
export const RESUME_HASH = "#/resume";
export const SLIDES_HASH = "#/slides";
export const KNOWLEDGE_HASH = "#/knowledge";
export const IMPORT_HASH = "#/import";
export const FAVORITES_HASH = "#/favorites";
export const SKILLS_HASH = "#/skills";
export const SETTINGS_SYSTEM_HASH = "#/settings/system";
export const SETTINGS_API_HASH = "#/settings/api";

/** Hash of one persisted quiz set's detail page. */
export function quizSetHash(id: string): string {
  return `#/quiz/set/${encodeURIComponent(id)}`;
}

/** Parse the current location hash into a [`Route`]. */
export function parseHash(): Route {
  const match = /^#\/settings\/(system|api)\/?$/.exec(window.location.hash);
  if (match !== null) {
    return { view: "settings", tab: match[1] as SettingsTab };
  }
  if (/^#\/favorites\/?$/.test(window.location.hash)) {
    return { view: "favorites" };
  }
  if (/^#\/notes\/?$/.test(window.location.hash)) {
    return { view: "notes" };
  }
  const quizSetMatch = /^#\/quiz\/set\/([^/]+)\/?$/.exec(window.location.hash);
  if (quizSetMatch !== null) {
    return { view: "quiz-set", setId: decodeURIComponent(quizSetMatch[1]) };
  }
  if (/^#\/quiz\/?$/.test(window.location.hash)) {
    return { view: "quiz" };
  }
  if (/^#\/resume\/?$/.test(window.location.hash)) {
    return { view: "resume" };
  }
  if (/^#\/slides\/?$/.test(window.location.hash)) {
    return { view: "slides" };
  }
  if (/^#\/knowledge\/?$/.test(window.location.hash)) {
    return { view: "knowledge" };
  }
  if (/^#\/import\/?$/.test(window.location.hash)) {
    return { view: "import" };
  }
  if (/^#\/skills\/?$/.test(window.location.hash)) {
    return { view: "skills" };
  }
  return { view: "home" };
}

/** Subscribe to hash changes; returns the current route. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

/** Navigate by setting the location hash. */
export function navigate(hash: string): void {
  window.location.hash = hash;
}

/**
 * A cross-view jump requested by the command palette. Views with internal
 * selection state (chat / notes) receive it as a prop and consume it via
 * `onPendingConsumed` — plain navigation alone cannot select an item inside
 * an already-mounted view.
 */
export type PendingJump =
  | { kind: "open-session"; id: string }
  | { kind: "new-session" }
  | { kind: "open-note"; id: string }
  | { kind: "new-note" }
  | { kind: "draft"; text: string }
  | { kind: "view"; hash: string };
