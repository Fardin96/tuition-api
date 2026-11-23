import { Prisma } from "../../generated/prisma/client.js";
import {
  CaseStatus,
  FeeStatus,
  ListingStatus,
  RefundStatus,
} from "../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import type {
  DonutPayload,
  KpiPayload,
  QueuePayload,
  SeriesPayload,
  WidgetId,
} from "./dashboard.schema.js";
import type { WidgetComputer, WidgetContext } from "./dashboard.service.js";
import { bucketKeys, bucketSql, dhakaDate, rangeWindows, type Windows } from "./dashboard-time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type Color = DonutPayload["slices"][number]["color"];
type Point = { date: string; values: Record<string, number> };

// ───────────────────────── shared helpers ─────────────────────────

const num = (v: unknown): number => Number(v ?? 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const money = (v: unknown): number => Math.round(num(v) * 100) / 100;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** `count` consecutive Dhaka dates starting at `fromKey` (YYYY-MM-DD). */
function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayKeys(fromKey: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(fromKey, i));
}

/** One point per bucket key, with 0 wherever the query had no row for that bucket. */
function zeroFill<R extends { k: string }>(
  keys: string[],
  rows: R[],
  fields: (keyof R & string)[],
): Point[] {
  const byKey = new Map(rows.map((r) => [r.k, r]));
  return keys.map((date) => {
    const row = byKey.get(date);
    const values: Record<string, number> = {};
    for (const f of fields) values[f] = num(row?.[f]);
    return { date, values };
  });
}

/** Dhaka bucket key (YYYY-MM-DD) of a timestamptz column, sized to the window's bucket. */
const bucketOf = (column: string, w: Windows) => Prisma.raw(bucketSql(column, w.bucket));

function formatDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** First day the activity table holds (YYYY-MM-DD), or null when it is empty. */
async function trackingSince(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ d: string | null }[]>`
    SELECT to_char(MIN(day), 'YYYY-MM-DD') AS d FROM account_activity_day`;
  return rows[0]?.d ?? null;
}

/** The caveat shown when activity history starts after the window does. */
function trackingNote(since: string | null, windowStart: string): string | null {
  return since && since > windowStart ? `Tracking since ${formatDay(since)}` : null;
}

// ───────────────────────── accounts: sign-ups ─────────────────────────

type SignupRow = { k: string; students: number; tutors: number };

function signupRows(w: Windows, start: Date, end: Date): Promise<SignupRow[]> {
  return prisma.$queryRaw<SignupRow[]>`
    SELECT ${bucketOf("created_at", w)} AS k,
      count(*) FILTER (WHERE role = 'STUDENT')::int AS students,
      count(*) FILTER (WHERE role = 'TUTOR')::int AS tutors
    FROM account
    WHERE role IN ('STUDENT', 'TUTOR') AND created_at >= ${start} AND created_at < ${end}
    GROUP BY k`;
}

const signups = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [cur, prev] = await Promise.all([
    signupRows(w, w.start, w.end),
    signupRows(w, w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "count",
    value: sum(cur.map((r) => r.students + r.tutors)),
    previous: sum(prev.map((r) => r.students + r.tutors)),
    higherIsBetter: true,
    spark: zeroFill(
      bucketKeys(w),
      cur.map((r) => ({ k: r.k, value: r.students + r.tutors })),
      ["value"],
    ),
    breakdown: [
      { label: "Students", value: sum(cur.map((r) => r.students)) },
      { label: "Tutors", value: sum(cur.map((r) => r.tutors)) },
    ],
    note: null,
  };
};

const signupsTrend = async ({ range, now }: WidgetContext): Promise<SeriesPayload> => {
  const w = rangeWindows(range, now);
  const rows = await signupRows(w, w.start, w.end);
  return {
    kind: "series",
    chart: "stacked-area",
    format: "count",
    series: [
      { key: "students", label: "Students", color: "chart-1" },
      { key: "tutors", label: "Tutors", color: "chart-2" },
    ],
    points: zeroFill(bucketKeys(w), rows, ["students", "tutors"]),
    totals: {
      students: sum(rows.map((r) => r.students)),
      tutors: sum(rows.map((r) => r.tutors)),
    },
    note: null,
  };
};

// ───────────────────────── accounts: monthly and daily actives ─────────────────────────

/** Distinct non-admin, active accounts with a session day in [fromKey, toKey). */
async function activeAccounts(fromKey: string, toKey: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(DISTINCT d.account_id)::int AS n
    FROM account_activity_day d JOIN account a ON a.id = d.account_id
    WHERE a.role <> 'ADMIN' AND a.status = 'ACTIVE'
      AND d.day >= ${fromKey}::date AND d.day < ${toKey}::date`;
  return num(rows[0]?.n);
}

const mau = async ({ now }: WidgetContext): Promise<KpiPayload> => {
  const today = dhakaDate(now);
  const trailStart = addDays(today, -29);
  const prevStart = addDays(today, -59);
  const [value, previousCount, since, sparkRows] = await Promise.all([
    activeAccounts(trailStart, addDays(today, 1)),
    activeAccounts(prevStart, trailStart),
    trackingSince(),
    prisma.$queryRaw<{ k: string; value: number }[]>`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS k, count(DISTINCT d.account_id)::int AS value
      FROM account_activity_day d JOIN account a ON a.id = d.account_id
      WHERE a.role <> 'ADMIN' AND a.status = 'ACTIVE' AND d.day >= ${trailStart}::date
      GROUP BY k`,
  ]);
  // The previous window is only honest when the history reaches back to its first day.
  const previous = since !== null && since <= prevStart ? previousCount : null;
  return {
    kind: "kpi",
    format: "count",
    value,
    previous,
    higherIsBetter: true,
    spark: zeroFill(dayKeys(trailStart, 30), sparkRows, ["value"]),
    breakdown: [],
    note: trackingNote(since, trailStart),
  };
};

const activityTrend = async ({ range, now }: WidgetContext): Promise<SeriesPayload> => {
  const w = rangeWindows(range, now);
  const startKey = dhakaDate(w.start);
  const keyExpr =
    w.bucket === "month"
      ? "to_char(date_trunc('month', d.day), 'YYYY-MM-DD')"
      : "to_char(d.day, 'YYYY-MM-DD')";
  const [rows, windowTotal, since] = await Promise.all([
    prisma.$queryRaw<{ k: string; active: number }[]>`
      SELECT ${Prisma.raw(keyExpr)} AS k, count(DISTINCT d.account_id)::int AS active
      FROM account_activity_day d JOIN account a ON a.id = d.account_id
      WHERE a.role <> 'ADMIN' AND a.status = 'ACTIVE' AND d.day >= ${startKey}::date
      GROUP BY k`,
    // Distinct across the whole window: someone active in two buckets counts once.
    activeAccounts(startKey, addDays(dhakaDate(w.end), 1)),
    trackingSince(),
  ]);
  return {
    kind: "series",
    chart: "area",
    format: "count",
    series: [{ key: "active", label: "Active users", color: "chart-1" }],
    points: zeroFill(bucketKeys(w), rows, ["active"]),
    totals: { active: windowTotal },
    note: trackingNote(since, startKey),
  };
};

// ───────────────────────── money: fee ledger ─────────────────────────

// REVERSAL amounts are stored positive (constraints.sql), so net = payments - reversals.
type FeeRow = { k: string; collected: number; refunded: number };

function feeRows(w: Windows, start: Date, end: Date): Promise<FeeRow[]> {
  return prisma.$queryRaw<FeeRow[]>`
    SELECT ${bucketOf("received_at", w)} AS k,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'PAYMENT'), 0)::float8 AS collected,
      COALESCE(SUM(amount) FILTER (WHERE kind = 'REVERSAL'), 0)::float8 AS refunded
    FROM fee_payment
    WHERE received_at >= ${start} AND received_at < ${end}
    GROUP BY k`;
}

const netOf = (rows: FeeRow[]): number =>
  money(sum(rows.map((r) => r.collected)) - sum(rows.map((r) => r.refunded)));

const collected = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [cur, prev] = await Promise.all([
    feeRows(w, w.start, w.end),
    feeRows(w, w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "money",
    value: netOf(cur),
    previous: netOf(prev),
    higherIsBetter: true,
    spark: zeroFill(
      bucketKeys(w),
      cur.map((r) => ({ k: r.k, value: money(r.collected - r.refunded) })),
      ["value"],
    ),
    breakdown: [],
    note: null,
  };
};

const revenueTrend = async ({ range, now }: WidgetContext): Promise<SeriesPayload> => {
  const w = rangeWindows(range, now);
  const rows = await feeRows(w, w.start, w.end);
  return {
    kind: "series",
    chart: "bar",
    format: "money",
    series: [
      { key: "collected", label: "Collected", color: "chart-1" },
      { key: "refunded", label: "Refunded", color: "chart-2" },
    ],
    points: zeroFill(
      bucketKeys(w),
      rows.map((r) => ({ k: r.k, collected: money(r.collected), refunded: money(r.refunded) })),
      ["collected", "refunded"],
    ),
    totals: {
      collected: money(sum(rows.map((r) => r.collected))),
      refunded: money(sum(rows.map((r) => r.refunded))),
    },
    note: null,
  };
};

// ───────────────────────── money: fees ─────────────────────────

const collectionRate = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [value, previous] = await Promise.all([
    collectionRateFor(w.start, w.end),
    collectionRateFor(w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "percent",
    value,
    previous,
    higherIsBetter: true,
    spark: [],
    breakdown: [],
    note: null,
  };
};

async function collectionRateFor(start: Date, end: Date): Promise<number | null> {
  const agg = await prisma.platformFee.aggregate({
    where: {
      status: { in: [FeeStatus.DUE, FeeStatus.PARTIAL, FeeStatus.PAID] },
      createdAt: { gte: start, lt: end },
    },
    _sum: { amountDue: true, amountPaid: true },
  });
  const due = num(agg._sum.amountDue);
  return due > 0 ? num(agg._sum.amountPaid) / due : null;
}

const OVERDUE_SLICES: { key: string; label: string; color: Color }[] = [
  { key: "d1_7", label: "1–7 days", color: "chart-1" },
  { key: "d8_30", label: "8–30 days", color: "chart-2" },
  { key: "d30", label: "Over 30 days", color: "chart-3" },
];

const overdueFees = async ({ now }: WidgetContext): Promise<DonutPayload> => {
  const today = dhakaDate(now);
  const rows = await prisma.$queryRaw<{ k: string; remaining: number }[]>`
    SELECT CASE
        WHEN ${today}::date - due_date <= 7 THEN 'd1_7'
        WHEN ${today}::date - due_date <= 30 THEN 'd8_30'
        ELSE 'd30'
      END AS k,
      SUM(amount_due - amount_paid)::float8 AS remaining
    FROM platform_fee
    WHERE status IN ('DUE', 'PARTIAL') AND due_date < ${today}::date
    GROUP BY k`;
  const remaining = new Map(rows.map((r) => [r.k, money(r.remaining)]));
  const slices = OVERDUE_SLICES.map((s) => ({ ...s, value: remaining.get(s.key) ?? 0 }));
  const total = money(sum(slices.map((s) => s.value)));
  return {
    kind: "donut",
    format: "money",
    slices,
    center: { label: "Overdue", value: total, format: "money" },
    note: "Now, whatever range is selected.",
  };
};

// ───────────────────────── placements and fill ─────────────────────────

type PlacementRow = { k: string; total: number; fromRequirements: number; fromPackages: number };

function placementRows(w: Windows, start: Date, end: Date): Promise<PlacementRow[]> {
  return prisma.$queryRaw<PlacementRow[]>`
    SELECT ${bucketOf("confirmed_at", w)} AS k,
      count(*)::int AS total,
      count(requirement_id)::int AS "fromRequirements",
      count(package_id)::int AS "fromPackages"
    FROM application
    WHERE confirmed_at >= ${start} AND confirmed_at < ${end}
    GROUP BY k`;
}

const placements = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [cur, prev] = await Promise.all([
    placementRows(w, w.start, w.end),
    placementRows(w, w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "count",
    value: sum(cur.map((r) => num(r.total))),
    previous: sum(prev.map((r) => num(r.total))),
    higherIsBetter: true,
    spark: zeroFill(
      bucketKeys(w),
      cur.map((r) => ({ k: r.k, value: num(r.total) })),
      ["value"],
    ),
    breakdown: [
      { label: "From requirements", value: sum(cur.map((r) => num(r.fromRequirements))) },
      { label: "From packages", value: sum(cur.map((r) => num(r.fromPackages))) },
    ],
    note: null,
  };
};

/** Share of non-draft requirements created in [start, end) with a confirmed application. */
async function fillRateFor(start: Date, end: Date): Promise<number | null> {
  const where = { status: { not: ListingStatus.DRAFT }, createdAt: { gte: start, lt: end } };
  const [total, filled] = await Promise.all([
    prisma.tuitionRequirement.count({ where }),
    prisma.tuitionRequirement.count({
      where: { ...where, applications: { some: { confirmedAt: { not: null } } } },
    }),
  ]);
  return total === 0 ? null : filled / total;
}

const fillRate = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [value, previous] = await Promise.all([
    fillRateFor(w.start, w.end),
    fillRateFor(w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "percent",
    value,
    previous,
    higherIsBetter: true,
    spark: [],
    breakdown: [],
    note: "Recent requirements may still fill.",
  };
};

/** Median days from requirement posting to its first confirmation inside [start, end). */
async function medianHireDays(start: Date, end: Date): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ median: number | null }[]>`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY f.days) AS median
    FROM (
      SELECT (EXTRACT(EPOCH FROM (MIN(a.confirmed_at) - r.created_at)) / 86400.0)::float8 AS days
      FROM application a
      JOIN tuition_requirement r ON r.id = a.requirement_id
      WHERE a.confirmed_at >= ${start} AND a.confirmed_at < ${end}
      GROUP BY a.requirement_id, r.created_at
    ) f`;
  const median = rows[0]?.median;
  return median == null ? null : round1(Number(median));
}

const timeToHire = async ({ range, now }: WidgetContext): Promise<KpiPayload> => {
  const w = rangeWindows(range, now);
  const [value, previous] = await Promise.all([
    medianHireDays(w.start, w.end),
    medianHireDays(w.prevStart, w.prevEnd),
  ]);
  return {
    kind: "kpi",
    format: "days",
    value,
    previous,
    higherIsBetter: false,
    spark: [],
    breakdown: [],
    note: null,
  };
};

// ───────────────────────── payments and cases ─────────────────────────

const paymentHealth = async ({ range, now }: WidgetContext): Promise<DonutPayload> => {
  const w = rangeWindows(range, now);
  const rows = await prisma.$queryRaw<{ status: string; n: number }[]>`
    SELECT status::text AS status, count(*)::int AS n
    FROM payment_attempt
    WHERE created_at >= ${w.start} AND created_at < ${w.end}
    GROUP BY status`;
  const count = (...statuses: string[]) =>
    sum(rows.filter((r) => statuses.includes(r.status)).map((r) => num(r.n)));
  const succeeded = count("SUCCEEDED");
  const review = count("REVIEW", "UNAPPLIED");
  const failed = count("FAILED", "CANCELLED", "EXPIRED");
  const open = count("PENDING");
  const decided = succeeded + review + failed;
  return {
    kind: "donut",
    format: "count",
    slices: [
      { key: "succeeded", label: "Succeeded", value: succeeded, color: "good" },
      { key: "review", label: "Needs a decision", value: review, color: "warn" },
      { key: "failed", label: "Failed or cancelled", value: failed, color: "bad" },
      { key: "other", label: "Still open", value: open, color: "chart-4" },
    ],
    center: {
      label: "Success rate",
      value: decided > 0 ? succeeded / decided : null,
      format: "percent",
    },
    note: null,
  };
};

type CaseRow = { k: string; n: number };

/** Reports and disputes grouped by the bucket of `column` (created_at to open, resolved_at to close). */
function caseRows(w: Windows, column: "created_at" | "resolved_at", start: Date, end: Date) {
  const col = Prisma.raw(column);
  const key = bucketOf(column, w);
  return prisma.$queryRaw<CaseRow[]>`
    SELECT k, count(*)::int AS n FROM (
      SELECT ${key} AS k FROM report WHERE ${col} >= ${start} AND ${col} < ${end}
      UNION ALL
      SELECT ${key} AS k FROM dispute WHERE ${col} >= ${start} AND ${col} < ${end}
    ) cases
    GROUP BY k`;
}

const trustCases = async ({ range, now }: WidgetContext): Promise<SeriesPayload> => {
  const w = rangeWindows(range, now);
  const [opened, closed] = await Promise.all([
    caseRows(w, "created_at", w.start, w.end),
    caseRows(w, "resolved_at", w.start, w.end),
  ]);
  const openedByKey = new Map(opened.map((r) => [r.k, num(r.n)]));
  const closedByKey = new Map(closed.map((r) => [r.k, num(r.n)]));
  return {
    kind: "series",
    chart: "bar",
    format: "count",
    series: [
      { key: "opened", label: "Opened", color: "chart-1" },
      { key: "closed", label: "Closed", color: "chart-2" },
    ],
    points: bucketKeys(w).map((date) => ({
      date,
      values: { opened: openedByKey.get(date) ?? 0, closed: closedByKey.get(date) ?? 0 },
    })),
    totals: {
      opened: sum(opened.map((r) => num(r.n))),
      closed: sum(closed.map((r) => num(r.n))),
    },
    note: null,
  };
};

// ───────────────────────── needs attention ─────────────────────────

/** Target hours per queue. Late at or past the target; watch past half of it. */
export const QUEUE_SLA_HOURS = {
  verifications: 24,
  packages: 24,
  videos: 48,
  stories: 72,
  reports: 24,
  disputes: 24,
  refunds: 48,
  "payments-review": 24,
  "payments-unapplied": 24,
  "zone-requests": 48,
  unserved: 48,
} as const;

/** A requirement counts as unserved once it has waited this long with no applicants. */
const UNSERVED_AFTER_HOURS = 72;

type Waiting = { count: number; oldest: Date | null };
type QueueKey = keyof typeof QUEUE_SLA_HOURS;
type QueueSpec = {
  key: QueueKey;
  label: string;
  href: string;
  load: (now: Date) => Promise<Waiting>;
};
type AggregateOf<K extends string> = { _count: number; _min: Record<K, Date | null> };

const waitingFrom =
  <K extends string>(field: K) =>
  (r: AggregateOf<K>): Waiting => ({ count: r._count, oldest: r._min[field] });

function earliest(...dates: (Date | null)[]): Date | null {
  const times = dates.filter((d): d is Date => d !== null).map((d) => d.getTime());
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

const QUEUES: QueueSpec[] = [
  {
    key: "verifications",
    label: "ID checks",
    href: "/dashboard/admin/verifications",
    load: async () => {
      const [tutor, student] = await Promise.all([
        prisma.tutorVerification.aggregate({
          where: { status: "PENDING" },
          _count: true,
          _min: { submittedAt: true },
        }),
        prisma.student.aggregate({
          where: { verificationStatus: "PENDING", verificationSubmittedAt: { not: null } },
          _count: true,
          _min: { verificationSubmittedAt: true },
        }),
      ]);
      return {
        count: tutor._count + student._count,
        oldest: earliest(tutor._min.submittedAt, student._min.verificationSubmittedAt),
      };
    },
  },
  {
    key: "packages",
    label: "Packages to approve",
    href: "/dashboard/admin/packages",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.tuitionPackage.aggregate({
          where: { moderationStatus: "PENDING" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "videos",
    label: "Videos to review",
    href: "/dashboard/admin/videos",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.tutorVideo.aggregate({
          where: { status: "PENDING" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "stories",
    label: "Stories to review",
    href: "/dashboard/admin/stories",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.story.aggregate({
          where: { status: "PENDING" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "reports",
    label: "Open reports",
    href: "/dashboard/admin/reports",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.report.aggregate({
          where: { status: { in: [CaseStatus.OPEN, CaseStatus.UNDER_REVIEW] } },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "disputes",
    label: "Open disputes",
    href: "/dashboard/admin/disputes",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.dispute.aggregate({
          where: { status: { in: [CaseStatus.OPEN, CaseStatus.UNDER_REVIEW] } },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "refunds",
    label: "Refunds to handle",
    href: "/dashboard/admin/refunds",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.paymentRefund.aggregate({
          where: {
            status: {
              // PROCESSING waits on the gateway, not on an admin.
              in: [RefundStatus.REQUESTED, RefundStatus.NEEDS_REVIEW],
            },
          },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "payments-review",
    label: "Payments in review",
    href: "/dashboard/admin/payments",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.paymentAttempt.aggregate({
          where: { status: "REVIEW" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "payments-unapplied",
    label: "Payments to refund",
    href: "/dashboard/admin/payments",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.paymentAttempt.aggregate({
          where: { status: "UNAPPLIED" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "zone-requests",
    label: "Zone requests",
    href: "/dashboard/admin/zone-requests",
    load: async () =>
      waitingFrom("createdAt")(
        await prisma.zoneLimitRequest.aggregate({
          where: { status: "PENDING" },
          _count: true,
          _min: { createdAt: true },
        }),
      ),
  },
  {
    key: "unserved",
    label: "Requirements with no applicants",
    href: "/dashboard/admin/matching?tab=unmatched",
    load: async (now) => {
      const waiting = waitingFrom("createdAt")(
        await prisma.tuitionRequirement.aggregate({
          where: {
            status: ListingStatus.OPEN,
            createdAt: { lt: new Date(now.getTime() - UNSERVED_AFTER_HOURS * HOUR_MS) },
            applications: { none: {} },
          },
          _count: true,
          _min: { createdAt: true },
        }),
      );
      // Age counts from the 72-hour mark, so the row shows how long past it the oldest one is.
      return {
        count: waiting.count,
        oldest:
          waiting.oldest && new Date(waiting.oldest.getTime() + UNSERVED_AFTER_HOURS * HOUR_MS),
      };
    },
  },
];

function queueStatus(hours: number | null, sla: number): "ok" | "watch" | "late" {
  if (hours === null) return "ok";
  if (hours >= sla) return "late";
  if (hours >= sla / 2) return "watch";
  return "ok";
}

const queues = async ({ now }: WidgetContext): Promise<QueuePayload> => {
  const rows = await Promise.all(
    QUEUES.map(async (q) => {
      const { count, oldest } = await q.load(now);
      const hours = count > 0 && oldest ? (now.getTime() - oldest.getTime()) / HOUR_MS : null;
      return {
        key: q.key,
        label: q.label,
        count,
        oldestHours: hours === null ? null : round1(hours),
        status: queueStatus(hours, QUEUE_SLA_HOURS[q.key]),
        href: q.href,
      };
    }),
  );
  return { kind: "queue", rows };
};

// ───────────────────────── registry ─────────────────────────

export const WIDGETS: Record<Exclude<WidgetId, "bottleneck">, WidgetComputer> = {
  mau,
  signups,
  collected,
  placements,
  "signups-trend": signupsTrend,
  "revenue-trend": revenueTrend,
  queues,
  "fill-rate": fillRate,
  "time-to-hire": timeToHire,
  "collection-rate": collectionRate,
  "overdue-fees": overdueFees,
  "payment-health": paymentHealth,
  "trust-cases": trustCases,
  "activity-trend": activityTrend,
};
