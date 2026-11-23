import type { DashboardRange } from "./dashboard.schema.js";

// Bangladesh has no daylight saving, so Dhaka is always UTC+6.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Bucket = "day" | "month";

export type Windows = {
  /** Current window: [start, end). start is a Dhaka midnight (or the 1st of a Dhaka month). end is now. */
  start: Date;
  end: Date;
  /** The previous equal period, ending at the same point of its last day so "so far" compares fairly. */
  prevStart: Date;
  prevEnd: Date;
  bucket: Bucket;
};

/** The UTC instant of Dhaka midnight on the Dhaka calendar day that contains `at`. */
export function dhakaDayStart(at: Date): Date {
  const local = at.getTime() + DHAKA_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - DHAKA_OFFSET_MS);
}

/** YYYY-MM-DD of the Dhaka calendar day that contains `at`. */
export function dhakaDate(at: Date): string {
  return new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

function addDhakaMonths(monthStart: Date, months: number): Date {
  const local = new Date(monthStart.getTime() + DHAKA_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + months, 1) - DHAKA_OFFSET_MS,
  );
}

function dhakaMonthStart(at: Date): Date {
  const local = new Date(at.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - DHAKA_OFFSET_MS);
}

const DAYS: Record<Exclude<DashboardRange, "12m">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** Windows for a range: day ranges cover N whole Dhaka days ending today; 12m covers 12 Dhaka months ending this one. */
export function rangeWindows(range: DashboardRange, now: Date): Windows {
  if (range === "12m") {
    const start = addDhakaMonths(dhakaMonthStart(now), -11);
    const prevStart = addDhakaMonths(start, -12);
    return {
      start,
      end: now,
      prevStart,
      prevEnd: new Date(now.getTime() - (start.getTime() - prevStart.getTime())),
      bucket: "month",
    };
  }
  const days = DAYS[range];
  const start = new Date(dhakaDayStart(now).getTime() - (days - 1) * DAY_MS);
  const span = days * DAY_MS;
  return {
    start,
    end: now,
    prevStart: new Date(start.getTime() - span),
    prevEnd: new Date(now.getTime() - span),
    bucket: "day",
  };
}

/** The fixed trailing-30-day windows the bottleneck flags are judged on, whatever range is selected. */
export function flagWindows(now: Date): Windows {
  return rangeWindows("30d", now);
}

/** Every bucket key (YYYY-MM-DD) in [start, end), so a series can be zero-filled. */
export function bucketKeys(windows: Windows): string[] {
  const keys: string[] = [];
  if (windows.bucket === "month") {
    for (let at = windows.start; at < windows.end; at = addDhakaMonths(at, 1))
      keys.push(dhakaDate(at));
    return keys;
  }
  for (let at = windows.start.getTime(); at < windows.end.getTime(); at += DAY_MS)
    keys.push(dhakaDate(new Date(at)));
  return keys;
}

/**
 * SQL for the Dhaka bucket key of a timestamptz column, as text YYYY-MM-DD, for use inside
 * Prisma.raw. Example: `${bucketSql("a.created_at", w.bucket)}`.
 */
export function bucketSql(column: string, bucket: Bucket): string {
  return `to_char(date_trunc('${bucket}', ${column} AT TIME ZONE 'Asia/Dhaka'), 'YYYY-MM-DD')`;
}
