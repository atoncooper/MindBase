/** 引用/参考文献渲染：plain、APA、IEEE、GB/T 7714。 */

import type { AcademicCitationStyle } from "../../repository/academic.js";

/**
 * The subset of an entry the renderers read. Structural so a full
 * AcademicLiteratureEntry (or a test double) can be passed unchanged.
 */
export type CitationEntry = {
  citeKey: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
};

/** Family name plus given-name tokens of one author string (see the heuristic above). */
interface NameParts {
  family: string;
  given: string[];
}

/** Split "San Zhang" into { family: "Zhang", given: ["San"] }; a mononym keeps its whole value as the family. */
function splitName(raw: string): NameParts {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { family: "", given: [] };
  if (tokens.length === 1) return { family: tokens[0], given: [] };
  return { family: tokens[tokens.length - 1], given: tokens.slice(0, -1) };
}

/** "San" -> "S."; "Jean Paul" -> "J. P."; "Jean-Paul" -> "J.-P." (uppercase initial + period per token). */
function initialsOf(tokens: string[]): string {
  return tokens
    .map((token) =>
      token
        .split("-")
        .filter(Boolean)
        .map((part) => (part[0] ?? "").toUpperCase() + ".")
        .join("-"),
    )
    .filter(Boolean)
    .join(" ");
}

/** Non-empty, trimmed author list; blank entries are dropped instead of rendered as empty names. */
function authorNames(entry: CitationEntry): string[] {
  return (entry.authors ?? []).map((author) => author.trim()).filter(Boolean);
}

/** APA: "Zhang, S." / mononym "张三"; blank authors yield "". */
function apaName(author: string): string {
  const { family, given } = splitName(author);
  if (!family) return "";
  const initials = initialsOf(given);
  return initials ? family + ", " + initials : family;
}

/** APA author segment: "Zhang, S.", "Zhang, S., & Li, S.", "Zhang, S., Li, S., & Wang, W.". */
function apaAuthors(authors: string[]): string {
  const names = authors.map(apaName).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ", & " + names[1];
  return names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
}

/** IEEE: "S. Zhang" / mononym "张三"; blank authors yield "". */
function ieeeName(author: string): string {
  const { family, given } = splitName(author);
  if (!family) return "";
  const initials = initialsOf(given);
  return initials ? initials + " " + family : family;
}

/** IEEE author segment: "S. Zhang", "S. Zhang and S. Li", "S. Zhang, S. Li, and W. Wang". */
function ieeeAuthors(authors: string[]): string {
  const names = authors.map(ieeeName).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

/** GB/T 7714: family name uppercased, given name kept as stored ("San Zhang" -> "ZHANG San"). */
function gbName(author: string): string {
  const { family, given } = splitName(author);
  if (!family) return "";
  const surname = family.toUpperCase();
  return given.length > 0 ? surname + " " + given.join(" ") : surname;
}

/** GB/T 7714 author segment: up to three names, then the Chinese et-al marker "等". */
function gbAuthors(authors: string[]): string {
  const names = authors.map(gbName).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return names.slice(0, 3).join(", ") + ", 等";
}

/** Stored title, trimmed; the contract requires one, the fallback keeps malformed rows renderable. */
function titleOf(entry: CitationEntry): string {
  const title = (entry.title ?? "").trim().replace(/\s+/g, " ");
  return title || "（无标题）";
}

/** Append a sentence-ending period unless the text already ends with terminal punctuation. */
function withPeriod(text: string): string {
  if (!text) return "";
  return /[.?!。？！]$/.test(text) ? text : text + ".";
}

/** DOI / URL tail shared by plain, APA and GB/T 7714: the stored DOI wins, otherwise the stored URL. */
function doiOrUrl(entry: CitationEntry): string {
  const doi = (entry.doi ?? "").trim();
  if (doi) return doi;
  return (entry.url ?? "").trim();
}

/** plain: "San Zhang, Si Li. Title. Venue, 2024. DOI: 10.1/x." (missing parts omitted). */
function renderPlain(entry: CitationEntry): string {
  const parts: string[] = [];
  const authors = authorNames(entry).join(", ");
  if (authors) parts.push(withPeriod(authors));
  parts.push(withPeriod(titleOf(entry)));
  const venue = (entry.venue ?? "").trim();
  const year = entry.year ? String(entry.year) : "";
  if (venue && year) parts.push(withPeriod(venue + ", " + year));
  else if (venue) parts.push(withPeriod(venue));
  else if (year) parts.push(withPeriod(year));
  const tail = doiOrUrl(entry);
  if (tail) parts.push(withPeriod((entry.doi ?? "").trim() ? "DOI: " + tail : tail));
  return parts.join(" ");
}

/** APA 7: "Zhang, S., & Li, S. (2024). Title. Venue. https://doi.org/10.1/x". */
function renderApa(entry: CitationEntry): string {
  const parts: string[] = [];
  const authors = apaAuthors(authorNames(entry));
  const title = withPeriod(titleOf(entry));
  const year = entry.year ? "(" + entry.year + ")." : "";
  if (authors) {
    parts.push(withPeriod(authors));
    if (year) parts.push(year);
    parts.push(title);
  } else {
    // APA 7: a work without an author moves the title into the author position.
    parts.push(year ? title + " " + year : title);
  }
  const venue = (entry.venue ?? "").trim();
  if (venue) parts.push(withPeriod(venue));
  const doi = (entry.doi ?? "").trim();
  if (doi) parts.push("https://doi.org/" + doi);
  else {
    const url = (entry.url ?? "").trim();
    if (url) parts.push(url);
  }
  return parts.join(" ");
}

/** IEEE: "S. Zhang and S. Li, "Title," Venue, 2024, doi: 10.1/x." (missing parts omitted). */
function renderIeee(entry: CitationEntry): string {
  const authors = ieeeAuthors(authorNames(entry));
  const title = titleOf(entry);
  const tail: string[] = [];
  const venue = (entry.venue ?? "").trim();
  if (venue) tail.push(venue);
  if (entry.year) tail.push(String(entry.year));
  const doi = (entry.doi ?? "").trim();
  if (doi) tail.push("doi: " + doi);
  else {
    const url = (entry.url ?? "").trim();
    if (url) tail.push("[Online]. Available: " + url);
  }
  if (tail.length === 0) {
    // No venue/year/DOI: close the sentence inside the quotes ("Title."), matching
    // the comma-inside-quotes form used when a tail exists.
    const quoted = '"' + withPeriod(title) + '"';
    return authors ? authors + ", " + quoted : quoted;
  }
  const head = authors ? authors + ', "' + title + ',"' : '"' + title + ',"';
  return withPeriod(head + " " + tail.join(", "));
}

/**
 * GB/T 7714: "ZHANG San, LI Si. Title[J]. Venue, 2024. DOI: 10.1/x."
 *
 * The library does not store a document type, so the paper marker "[J]" is the
 * default (the domain only manages journal/conference papers); volume/issue/pages
 * are omitted because they are not stored.
 */
function renderGb7714(entry: CitationEntry): string {
  const parts: string[] = [];
  const authors = gbAuthors(authorNames(entry));
  if (authors) parts.push(withPeriod(authors));
  parts.push(withPeriod(titleOf(entry) + "[J]"));
  const venue = (entry.venue ?? "").trim();
  const year = entry.year ? String(entry.year) : "";
  if (venue && year) parts.push(withPeriod(venue + ", " + year));
  else if (venue) parts.push(withPeriod(venue));
  else if (year) parts.push(withPeriod(year));
  const tail = doiOrUrl(entry);
  if (tail) parts.push(withPeriod((entry.doi ?? "").trim() ? "DOI: " + tail : tail));
  return parts.join(" ");
}

/**
 * Render one library entry as a full reference in the requested style.
 *
 * Unknown runtime styles fall back to plain, so a stale stored project style can
 * never crash an export. Missing metadata is omitted (never filled with "n.d.",
 * "unknown" or a guessed year).
 */
export function formatCitation(entry: CitationEntry, style: AcademicCitationStyle): string {
  switch (style) {
    case "apa":
      return renderApa(entry);
    case "ieee":
      return renderIeee(entry);
    case "gb7714":
      return renderGb7714(entry);
    case "plain":
    default:
      return renderPlain(entry);
  }
}

/** Case-insensitive citeKey ordering with a case-sensitive tie-break, locale-independent for stable output. */
function compareCiteKey(left: CitationEntry, right: CitationEntry): number {
  const a = (left.citeKey ?? "").toLowerCase();
  const b = (right.citeKey ?? "").toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  const rawA = left.citeKey ?? "";
  const rawB = right.citeKey ?? "";
  if (rawA === rawB) return 0;
  return rawA < rawB ? -1 : 1;
}

/**
 * Render a whole bibliography sorted by citeKey (case-insensitive). IEEE entries
 * are numbered "[1] …" in that sorted order; the other styles stay unnumbered.
 * An empty library yields "" (callers decide the guidance text).
 */
export function formatBibliography(
  entries: readonly CitationEntry[],
  style: AcademicCitationStyle,
): string {
  const sorted = [...entries].sort(compareCiteKey);
  return sorted
    .map((entry, index) =>
      style === "ieee"
        ? "[" + (index + 1) + "] " + formatCitation(entry, style)
        : formatCitation(entry, style),
    )
    .join("\n");
}
