// Time handling, reproducing the Spring backend's wire formats exactly.
//
// Storage conventions in the existing database (verified 2026-10-17):
//  * Business wall-clock times written by the app (attendance login/logout, break start/end) are
//    naive Asia/Kolkata local times.
//  * Times entered by users (follow_up_date, call_start_time...) are naive values as sent by the
//    browser.
//  * DB-defaulted created_at/updated_at and the app-set created_at of attendance/breaks are naive
//    UTC (the JVM and database both run in UTC).
//
// JSON output: Jackson serializes LocalDateTime with ISO_LOCAL_DATE_TIME — seconds always present,
// fraction only when non-zero with trailing zeros removed, and NO offset. The frontend parses these
// with `new Date(str)` as browser-local time, so a "Z" suffix would shift every displayed time.
//
// All arithmetic is done on integer microseconds of a naive timeline (as if UTC), which is what
// java.time.Duration.between(LocalDateTime, LocalDateTime) does.

export const BUSINESS_ZONE = "Asia/Kolkata";

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

/** "2026-10-17 13:09:00.905613" (Postgres text) -> "2026-10-17T13:09:00.905613" (Jackson). */
export function pgTextToJackson(v: string): string {
  const m = NAIVE_RE.exec(v);
  if (!m) return v; // e.g. "infinity" — pass through unchanged
  return formatJackson(toMicros(m));
}

function toMicros(m: RegExpExecArray): number {
  const [, y, mo, d, h, mi, s = "0", frac = ""] = m;
  const micros = Number((frac + "000000").slice(0, 6));
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) * 1000 + micros;
}

/** Parse a naive local date-time (either "T" or space separated) to timeline microseconds. */
export function micros(v: string): number {
  const m = NAIVE_RE.exec(v);
  if (!m) throw new Error(`Invalid local date-time: ${v}`);
  return toMicros(m);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function parts(us: number) {
  const ms = Math.floor(us / 1000);
  const d = new Date(ms);
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hh: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    fracMicros: ((us % 1_000_000) + 1_000_000) % 1_000_000,
  };
}

/** Jackson ISO_LOCAL_DATE_TIME: always seconds; fraction trimmed of trailing zeros. */
export function formatJackson(us: number): string {
  const p = parts(us);
  const frac = p.fracMicros ? "." + pad(p.fracMicros, 6).replace(/0+$/, "") : "";
  return `${p.date}T${p.hh}:${p.mm}:${p.ss}${frac}`;
}

/**
 * java.time.LocalDateTime#toString: seconds omitted when second and nano are both zero; fraction
 * printed in groups of 3 digits (.SSS / .SSSSSS). Used by DTOs that call toString() explicitly
 * (admin attendance, break summary).
 */
export function formatJavaToString(us: number): string {
  const p = parts(us);
  let out = `${p.date}T${p.hh}:${p.mm}`;
  if (p.ss !== "00" || p.fracMicros) {
    out += `:${p.ss}`;
    if (p.fracMicros) out += p.fracMicros % 1000 === 0 ? "." + pad(p.fracMicros / 1000, 3) : "." + pad(p.fracMicros, 6);
  }
  return out;
}

export function jacksonToJavaToString(v: string | null): string | null {
  return v == null ? null : formatJavaToString(micros(v));
}

const istFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

/** Current wall-clock time in the given zone as timeline microseconds (ms precision). */
function zonedNowMicros(nowMs: number, formatter: Intl.DateTimeFormat): number {
  const f = Object.fromEntries(formatter.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour), Number(f.minute), Number(f.second));
  return (wall + (nowMs % 1000)) * 1000;
}

export interface Clock {
  now(): number; // epoch milliseconds
}
export const systemClock: Clock = { now: () => Date.now() };

/** LocalDateTime.now(Asia/Kolkata) as microseconds. */
export function istNowMicros(clock: Clock = systemClock): number {
  return zonedNowMicros(clock.now(), istFormatter);
}
/** LocalDateTime.now(Asia/Kolkata) in Jackson format. */
export function istNow(clock: Clock = systemClock): string {
  return formatJackson(istNowMicros(clock));
}
/** LocalDate.now(Asia/Kolkata) as "YYYY-MM-DD". */
export function istToday(clock: Clock = systemClock): string {
  return istNow(clock).slice(0, 10);
}
/** LocalDateTime.now() on a UTC JVM — used for the app-set created_at/updated_at columns. */
export function utcNow(clock: Clock = systemClock): string {
  return formatJackson(clock.now() * 1000);
}

/** Midnight of a "YYYY-MM-DD" date as microseconds. */
export function dayStartMicros(date: string): number {
  return micros(`${date}T00:00:00`);
}
export function addDays(date: string, days: number): string {
  return formatJackson(dayStartMicros(date) + days * 86_400_000_000).slice(0, 10);
}

/** Duration.between(start, end).getSeconds() — floor division, may be negative. */
export function secondsBetween(startUs: number, endUs: number): number {
  return Math.floor((endUs - startUs) / 1_000_000);
}

/**
 * Parse a request LocalDateTime the way Jackson does: ISO local date-time with optional seconds and
 * fraction. A trailing "Z" is accepted leniently and converted to the UTC wall clock (Jackson's
 * lenient behaviour). Returns Jackson format, or throws for anything else.
 */
export function parseLocalDateTimeInput(v: string): string {
  if (/Z$/i.test(v)) {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new Error("invalid");
    return formatJackson(ms * 1000);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/.test(v)) throw new Error("invalid");
  const us = micros(v);
  // Reject impossible dates like 2026-02-31 (Date.UTC would roll them over).
  if (formatJackson(us).slice(0, 16) !== v.slice(0, 16)) throw new Error("invalid");
  return formatJackson(us);
}

export function parseLocalDateInput(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || addDays(v, 0) !== v) throw new Error("invalid");
  return v;
}
