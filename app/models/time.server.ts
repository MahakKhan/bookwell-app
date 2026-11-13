// Timezone helpers. All booking times are stored as UTC instants, but
// availability rules ("Mon 9:00-17:00") and the dates customers pick are
// expressed in the SHOP's timezone — never the server's (Render runs in
// UTC, which would silently shift every slot for non-UTC stores).

export function isValidTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeTz(tz?: string | null) {
  return tz && isValidTimezone(tz) ? tz : "UTC";
}

// Offset (ms) of `tz` from UTC at the given instant.
function tzOffsetMs(utcMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Converts a wall-clock "YYYY-MM-DD" + minutes-from-midnight in `tz` to a UTC Date. */
export function zonedToUtc(dateStr: string, minute: number, tzIn?: string | null): Date {
  const tz = safeTz(tzIn);
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minute, 0);
  let result = guess - tzOffsetMs(guess, tz);
  result = guess - tzOffsetMs(result, tz); // second pass settles DST edges
  return new Date(result);
}

export function addDays(dateStr: string, days: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from a to b ("YYYY-MM-DD"), b - a. */
export function daysBetween(a: string, b: string) {
  const pa = a.split("-").map(Number);
  const pb = b.split("-").map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000);
}

export function weekdayOf(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The wall-clock date/minute/weekday of an instant, as seen in `tz`. */
export function localParts(date: Date, tzIn?: string | null) {
  const tz = safeTz(tzIn);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    dateStr,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: weekdayOf(dateStr),
  };
}

export function formatInTz(
  date: Date,
  tzIn: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locale = "en-US",
) {
  return date.toLocaleString(locale, { ...options, timeZone: safeTz(tzIn) });
}
