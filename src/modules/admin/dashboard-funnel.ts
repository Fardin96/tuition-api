import { prisma } from "../../lib/prisma.js";
import type { FunnelPayload } from "./dashboard.schema.js";
import type { WidgetContext } from "./dashboard.service.js";
import { flagWindows, rangeWindows, type Windows } from "./dashboard-time.js";

// "Where it's stuck": cohort funnels. Each funnel follows one kind of entrant through ordered stages.
// An entrant counts at stage k if it reached k and its prerequisites (`requires`, default every earlier stage).

type FunnelKey = FunnelPayload["funnels"][number]["key"];
type FunnelStage = FunnelPayload["funnels"][number]["stages"][number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** A flag needs at least this many matured entrants in both the current and the previous 30 days. */
export const MIN_FLAG_SAMPLE = 30;
/** Days after entry before a stage is judged, so late movers are not counted as drop-offs. */
export const STAGE_MATURITY_DAYS: Record<FunnelKey, Record<string, number>> = {
  placement: { applied: 7, hired: 14, paid: 21 },
  tutors: { approved: 7, applied: 14, placed: 30 },
  students: { posted: 7, hired: 14 },
};

const FLAG_CONVERSION_DROP = 0.05;
const FLAG_WAIT_RATIO = 1.25;

/** One cohort member. reached[k] says it got to stage k at some point; times[k] is when (null if unknown). */
export type Entrant = {
  entered: Date;
  reached: boolean[];
  times: (Date | null)[];
  /** Placement only: the placement fee was voided, so the entrant leaves the paid-stage denominator. */
  voidFee: boolean;
};

export type StageSpec = {
  key: string;
  label: string;
  maturityDays: number;
  /** Drop entrants with a VOID fee from this stage's denominator. */
  dropVoid?: boolean;
  /** Earlier stages an entrant must have reached. Default: every earlier stage. */
  requires?: number[];
};

export type StageMeasure = {
  count: number;
  denominator: number;
  conversion: number | null;
  /** Median wait in days, rounded for display. */
  medianDays: number | null;
  /** The same median, unrounded. The wait flag is judged on this. */
  rawMedian: number | null;
};

type Span = { start: Date; end: Date };

/** Median of a list; the mean of the two middle values when the count is even. null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The prerequisite indexes of stage k: its `requires`, or every earlier stage. */
function requiredOf(stages: StageSpec[], k: number): number[] {
  return stages[k].requires ?? Array.from({ length: k }, (_, i) => i);
}

function reachedAll(entrant: Entrant, indexes: number[]): boolean {
  return indexes.every((i) => entrant.reached[i]);
}

/**
 * Counts one stage for the entrants who entered in [span.start, span.end) shifted back by shiftDays.
 * Conversion is count / denominator, where the denominator is the entrants who reached the stage's
 * prerequisites (minus VOID fees for a dropVoid stage). Wait samples are days from the last prerequisite.
 */
export function measureStage(
  entrants: Entrant[],
  stages: StageSpec[],
  k: number,
  span: Span,
  shiftDays = 0,
): StageMeasure {
  const shift = shiftDays * DAY_MS;
  const lo = span.start.getTime() - shift;
  const hi = span.end.getTime() - shift;
  const cohort = entrants.filter((e) => {
    const t = e.entered.getTime();
    return t >= lo && t < hi;
  });
  const requires = requiredOf(stages, k);
  // The wait starts at the last prerequisite (stage 0 when there are none).
  const fromIndex = requires.length > 0 ? Math.max(...requires) : 0;
  const reached = cohort.filter((e) => e.reached[k] && reachedAll(e, requires));
  const denominator =
    k === 0
      ? cohort.length
      : cohort.filter((e) => reachedAll(e, requires) && !(stages[k].dropVoid === true && e.voidFee))
          .length;
  const waits: number[] = [];
  if (k > 0) {
    for (const e of reached) {
      const from = e.times[fromIndex];
      const to = e.times[k];
      if (from && to) waits.push(Math.max(0, (to.getTime() - from.getTime()) / DAY_MS));
    }
  }
  const med = median(waits);
  return {
    count: reached.length,
    denominator,
    conversion: k === 0 || denominator === 0 ? null : reached.length / denominator,
    medianDays: med === null ? null : round1(med),
    rawMedian: med,
  };
}

function flagReason(cur: StageMeasure, prev: StageMeasure): string | null {
  if (cur.denominator < MIN_FLAG_SAMPLE || prev.denominator < MIN_FLAG_SAMPLE) return null;
  if (cur.conversion === null || prev.conversion === null) return null;
  const drop = prev.conversion - cur.conversion;
  if (drop >= FLAG_CONVERSION_DROP - 1e-9) {
    const pct = Math.round(cur.conversion * 100);
    return `${pct}%, down ${Math.round(drop * 100)} pts on the previous 30 days`;
  }
  if (
    prev.rawMedian !== null &&
    prev.rawMedian > 0 &&
    cur.rawMedian !== null &&
    cur.rawMedian >= FLAG_WAIT_RATIO * prev.rawMedian
  ) {
    return `Wait ${round1(cur.rawMedian).toFixed(1)} days, up from ${round1(prev.rawMedian).toFixed(1)} days`;
  }
  return null;
}

/**
 * The stage table for one funnel. `range` is the selected window (what the counts show);
 * `flag` is the trailing 30 days and the 30 before it (what the flags are judged on).
 */
export function computeFunnel(
  entrants: Entrant[],
  stages: StageSpec[],
  range: Windows,
  flag: Windows,
): FunnelStage[] {
  return stages.map((stage, k) => {
    const shown = measureStage(entrants, stages, k, range);
    const base = {
      key: stage.key,
      label: stage.label,
      count: shown.count,
      conversion: shown.conversion,
      medianDays: shown.medianDays,
    };
    if (k === 0) return { ...base, flagged: false, flagReason: null };
    const cur = measureStage(entrants, stages, k, flag, stage.maturityDays);
    const prev = measureStage(
      entrants,
      stages,
      k,
      { start: flag.prevStart, end: flag.prevEnd },
      stage.maturityDays,
    );
    const reason = flagReason(cur, prev);
    return { ...base, flagged: reason !== null, flagReason: reason };
  });
}

// ───────────────────────── loading ─────────────────────────
// shortcut: entrants are loaded into memory, fine at launch volumes; move the aggregation into SQL past ~50k entrants per year.

type PlacementRow = {
  entered: Date;
  applied: Date | null;
  hired: Date | null;
  feeStatus: string | null;
  paid: Date | null;
};
type TutorRow = {
  entered: Date;
  approved: Date | null;
  applied: Date | null;
  placed: Date | null;
};
type StudentRow = { entered: Date; posted: Date | null; hired: Date | null };

async function loadPlacement(from: Date, to: Date): Promise<Entrant[]> {
  const rows = await prisma.$queryRaw<PlacementRow[]>`
    SELECT
      tr.created_at AS entered,
      (SELECT MIN(a.applied_at) FROM application a WHERE a.requirement_id = tr.id) AS applied,
      (SELECT MIN(a.confirmed_at) FROM application a WHERE a.requirement_id = tr.id) AS hired,
      pf.status::text AS "feeStatus",
      (SELECT MAX(p.received_at) FROM fee_payment p
        WHERE p.fee_id = pf.id AND p.kind::text = 'PAYMENT') AS paid
    FROM tuition_requirement tr
    LEFT JOIN LATERAL (
      SELECT f.id, f.status
      FROM platform_fee f
      JOIN application fa ON fa.id = f.application_id
      WHERE fa.requirement_id = tr.id
        AND fa.confirmed_at IS NOT NULL
        AND f.fee_type::text = 'PLACEMENT'
      ORDER BY (f.status::text = 'VOID'), fa.confirmed_at, f.created_at, f.id
      LIMIT 1
    ) pf ON true
    WHERE tr.status::text <> 'DRAFT'
      AND tr.created_at >= ${from}
      AND tr.created_at < ${to}
  `;
  return rows.map((r) => {
    const paidOk = r.feeStatus === "PAID" || r.feeStatus === "WAIVED";
    return {
      entered: r.entered,
      reached: [true, r.applied !== null, r.hired !== null, paidOk],
      times: [r.entered, r.applied, r.hired, r.paid],
      voidFee: r.feeStatus === "VOID",
    };
  });
}

async function loadTutors(from: Date, to: Date): Promise<Entrant[]> {
  const rows = await prisma.$queryRaw<TutorRow[]>`
    SELECT
      a.created_at AS entered,
      (SELECT MIN(v.decided_at) FROM tutor_verification v
        WHERE v.tutor_id = t.id AND v.status::text = 'APPROVED') AS approved,
      (SELECT MIN(ap.applied_at) FROM application ap
        WHERE ap.tutor_id = t.id) AS applied,
      (SELECT MIN(ap.confirmed_at) FROM application ap WHERE ap.tutor_id = t.id) AS placed
    FROM account a
    LEFT JOIN tutor t ON t.account_id = a.id
    WHERE a.role::text = 'TUTOR'
      AND a.created_at >= ${from}
      AND a.created_at < ${to}
  `;
  return rows.map((r) => ({
    entered: r.entered,
    reached: [true, r.approved !== null, r.applied !== null, r.placed !== null],
    times: [r.entered, r.approved, r.applied, r.placed],
    voidFee: false,
  }));
}

async function loadStudents(from: Date, to: Date): Promise<Entrant[]> {
  const rows = await prisma.$queryRaw<StudentRow[]>`
    SELECT
      a.created_at AS entered,
      (SELECT MIN(tr.created_at) FROM tuition_requirement tr
        WHERE tr.student_id = s.id AND tr.status::text <> 'DRAFT') AS posted,
      (SELECT MIN(ap.confirmed_at) FROM application ap WHERE ap.student_id = s.id) AS hired
    FROM account a
    LEFT JOIN student s ON s.account_id = a.id
    WHERE a.role::text = 'STUDENT'
      AND a.created_at >= ${from}
      AND a.created_at < ${to}
  `;
  return rows.map((r) => ({
    entered: r.entered,
    reached: [true, r.posted !== null, r.hired !== null],
    times: [r.entered, r.posted, r.hired],
    voidFee: false,
  }));
}

const FUNNELS: {
  key: FunnelKey;
  label: string;
  stages: { key: string; label: string; requires?: number[] }[];
  load: (from: Date, to: Date) => Promise<Entrant[]>;
}[] = [
  {
    key: "placement",
    label: "Placement",
    stages: [
      { key: "posted", label: "Requirements posted" },
      { key: "applied", label: "Got an application" },
      { key: "hired", label: "Tutor hired" },
      { key: "paid", label: "Fee settled" },
    ],
    load: loadPlacement,
  },
  {
    key: "tutors",
    label: "Tutors",
    stages: [
      { key: "signed_up", label: "Signed up" },
      { key: "approved", label: "ID approved" },
      // Tutors can apply without ID approval when the verification switch is off.
      { key: "applied", label: "First application or request", requires: [0] },
      { key: "placed", label: "First placement", requires: [0, 2] },
    ],
    load: loadTutors,
  },
  {
    key: "students",
    label: "Students",
    stages: [
      { key: "signed_up", label: "Signed up" },
      { key: "posted", label: "Posted a requirement" },
      // A package request needs no posted requirement.
      { key: "hired", label: "Hired a tutor", requires: [0] },
    ],
    load: loadStudents,
  },
];

export async function bottleneckWidget(ctx: WidgetContext): Promise<FunnelPayload> {
  const range = rangeWindows(ctx.range, ctx.now, ctx.since);
  const flag = flagWindows(ctx.now);
  const funnels = await Promise.all(
    FUNNELS.map(async (def) => {
      const stages: StageSpec[] = def.stages.map((s, k) => ({
        key: s.key,
        label: s.label,
        maturityDays: k === 0 ? 0 : (STAGE_MATURITY_DAYS[def.key][s.key] ?? 0),
        dropVoid: def.key === "placement" && s.key === "paid",
        requires: s.requires,
      }));
      const maxMaturity = Math.max(...stages.map((s) => s.maturityDays));
      // Load once, wide enough for the selected range and the matured previous flag window.
      const from = new Date(
        Math.min(range.start.getTime(), flag.prevStart.getTime() - maxMaturity * DAY_MS),
      );
      const entrants = await def.load(from, ctx.now);
      return {
        key: def.key,
        label: def.label,
        stages: computeFunnel(entrants, stages, range, flag),
      };
    }),
  );
  return { kind: "funnel", funnels };
}
