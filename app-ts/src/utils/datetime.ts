import { config } from "../config/index.js";

/**
 * Timezone-aware date helpers. All persisted timestamps are epoch ms (timezone-safe);
 * the only timezone-sensitive surfaces are human-readable dates: the "today" in agent
 * prompts and Milvus monthly partition naming. Both go through here (default TZ from config).
 * Implemented with Intl — no external dependency.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone, ...options }); // en-CA → YYYY-MM-DD
    } catch {
      // invalid IANA name: fall back to UTC once, warn at runtime via caller
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...options });
    }
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar date "YYYY-MM-DD" for the given instant in the given timezone. */
export function formatDateIn(date: Date, timeZone: string = config.timezone.name): string {
  return formatterFor(timeZone).format(date);
}

/** Today's local date (configured timezone) — safe to call per request (formatter cached). */
export function today(timeZone: string = config.timezone.name): string {
  return formatDateIn(new Date(), timeZone);
}

/** Milvus monthly partition name `_YYYY_MM` in the configured timezone. */
export function partitionNameForMonth(date: Date, timeZone: string = config.timezone.name): string {
  const ymd = formatDateIn(date, timeZone);
  const [y, m] = ymd.split("-");
  return `_${y}_${m}`;
}
