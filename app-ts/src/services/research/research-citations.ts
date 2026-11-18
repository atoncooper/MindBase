/** 从 Markdown/LaTeX 文本提取引用 key（\cite、Pandoc [@key]、旧式 [key]）。 */

/** A legacy bare-bracket key: starts with a letter, >= 3 chars, alphanumerics/_/-, so never a pure number. */
const LEGACY_BARE_KEY = /^[A-Za-z][A-Za-z0-9_-]{2,}$/;

/**
 * One citation token, scanned left-to-right so the returned order matches the
 * document. Group 1 = LaTeX command arguments, group 2 = bracketed content.
 * \cite[pt]? deliberately covers \cite, \citep and \citet (not \citealp etc.).
 */
const CITATION_TOKEN = /\\cite[pt]?(?:\[[^\]]*\])*\{([^}]*)\}|\[([^\]]*)\]/g;

/**
 * A Pandoc "@key" inside a bracket. The leading boundary keeps e-mail addresses
 * ("user@example.com") out: only start-of-content, whitespace, "[", ";", "," or
 * a "-" (author-suppression citation "-@key") may precede the "@" that starts a
 * citation key. The key itself stops at whitespace/comma/semicolon/bracket.
 */
const PANDOC_KEY_TOKEN = /(?:^|[\s\[;,-])@([A-Za-z0-9][A-Za-z0-9_:.\-]*)/g;

/** Appends the comma-separated keys of a LaTeX cite command (empty segments ignored). */
function addLatexKeys(raw: string, keys: Set<string>): void {
  for (const piece of raw.split(",")) {
    const key = piece.trim();
    if (key !== "") keys.add(key);
  }
}

/**
 * Extracts the keys of one bracketed Pandoc group: "a, p.3; b" -> a, b. A comma
 * inside a citation introduces a locator ("p. 3", "pp. 33-35"), never a second
 * key, so the locator text is simply not matched (it carries no "@").
 */
function addPandocKeys(content: string, keys: Set<string>): void {
  for (const match of content.matchAll(PANDOC_KEY_TOKEN)) {
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }
}

/**
 * Extracts the keys of one legacy bare-bracket group: "zhang2024, li2023". Every
 * item must pass LEGACY_BARE_KEY; if any item looks like prose the whole group is
 * ignored (a mixed group is not a citation list).
 */
function addLegacyKeys(content: string, keys: Set<string>): void {
  const items = content.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0 || !items.every((item) => LEGACY_BARE_KEY.test(item))) return;
  for (const item of items) keys.add(item);
}

/**
 * Removes citation syntax from text (replaced by a space).
 *
 * Used by the numeric-section heuristic in research-validation.ts: citation keys
 * contain year digits (zhang2024) and LaTeX optional arguments may carry page
 * locators (p.3), so the raw body would flag almost every cited chapter as
 * "contains numbers". The replaced text is only fed to a /\d/ test — its exact
 * length does not matter.
 */
export function stripCitationSyntax(text: string): string {
  if (!text) return "";
  return text.replace(CITATION_TOKEN, " ");
}

/**
 * Extracts every citation key from manuscript text.
 *
 * Pure and deterministic: the same text always yields the same array. Keys are
 * deduplicated case-sensitively (citations are keys, not display names) and keep
 * their first-appearance order, which is what validation reports and export
 * rejection messages present to the user.
 */
export function parseCitationKeys(text: string): string[] {
  const keys = new Set<string>();
  if (!text) return [];
  for (const match of text.matchAll(CITATION_TOKEN)) {
    if (match[1] !== undefined) {
      // LaTeX command: its arguments are keys verbatim (old \cite behavior).
      addLatexKeys(match[1], keys);
      continue;
    }
    const content = match[2] ?? "";
    const end = (match.index ?? 0) + match[0].length;
    // Markdown link/image label: the bracket is followed by "(", not a citation.
    if (text[end] === "(") continue;
    // An "@" makes it a Pandoc citation; otherwise only legacy bare-key syntax applies.
    if (content.includes("@")) addPandocKeys(content, keys);
    else addLegacyKeys(content, keys);
  }
  return [...keys];
}
