import { z } from "zod";
import { WIDGET_IDS } from "./dashboard-registry.js";

// Admin business dashboard. Every widget returns one of five self-describing payloads, so the
// web app needs one renderer per kind and a new metric is a backend-only change.
// Money here is a plain number of taka (two decimals at most): charts need numbers.

export const dashboardRangeSchema = z.enum(["7d", "30d", "90d", "12m"]);
export type DashboardRange = z.infer<typeof dashboardRangeSchema>;

export const widgetIdSchema = z.enum(WIDGET_IDS);
export type WidgetId = z.infer<typeof widgetIdSchema>;

export const metricFormatSchema = z.enum(["count", "money", "percent", "days"]);
/** Colour token keys. chart-1..4 are categorical (blue, navy, violet, grey); good/warn/bad are status. */
export const colorTokenSchema = z.enum([
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "good",
  "warn",
  "bad",
]);

/** One bucket. `date` is the bucket start as a Dhaka calendar date, YYYY-MM-DD (month buckets use the 1st). */
const pointSchema = z.object({ date: z.string(), values: z.record(z.string(), z.number()) });
const seriesDefSchema = z.object({ key: z.string(), label: z.string(), color: colorTokenSchema });

export const kpiPayloadSchema = z.object({
  kind: z.literal("kpi"),
  format: metricFormatSchema,
  /** null when there is not enough data (see note). percent is 0..1. */
  value: z.number().nullable(),
  /** The same metric for the previous equal period; null when it can't be compared. */
  previous: z.number().nullable(),
  higherIsBetter: z.boolean(),
  /** Sparkline, values.value per bucket. Empty for metrics without history. */
  spark: z.array(pointSchema),
  /** Extra split shown under the number, for example students and tutors. */
  breakdown: z.array(z.object({ label: z.string(), value: z.number() })),
  /** A short honest caveat, for example "Tracking since 2 Dec 2026". */
  note: z.string().nullable(),
});

export const seriesPayloadSchema = z.object({
  kind: z.literal("series"),
  chart: z.enum(["area", "stacked-area", "bar"]),
  format: metricFormatSchema,
  series: z.array(seriesDefSchema),
  points: z.array(pointSchema),
  /** Total per series key over the range. */
  totals: z.record(z.string(), z.number()),
  note: z.string().nullable(),
});

const funnelStageSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Cohort members who reached this stage in the selected range ("so far"). */
  count: z.number().int(),
  /** Share of the entrants who reached this stage's prerequisites (the previous stage unless the funnel says otherwise), 0..1; null on the first stage or when that count is 0. */
  conversion: z.number().nullable(),
  /** Median days from the last prerequisite; null on the first stage or with no samples. */
  medianDays: z.number().nullable(),
  /** Judged on the trailing 30 days vs the 30 before, matured entrants, n >= 30 in both. */
  flagged: z.boolean(),
  /** Why it is flagged, for example "38%, down 7 pts on the previous 30 days". null when not flagged. */
  flagReason: z.string().nullable(),
});

export const funnelPayloadSchema = z.object({
  kind: z.literal("funnel"),
  funnels: z.array(
    z.object({
      key: z.enum(["placement", "tutors", "students"]),
      label: z.string(),
      stages: z.array(funnelStageSchema),
    }),
  ),
});

export const queuePayloadSchema = z.object({
  kind: z.literal("queue"),
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int(),
      /** Age of the oldest waiting item in hours; null when the queue is empty. */
      oldestHours: z.number().nullable(),
      status: z.enum(["ok", "watch", "late"]),
      /** Admin page to act on it. */
      href: z.string(),
    }),
  ),
});

export const donutPayloadSchema = z.object({
  kind: z.literal("donut"),
  format: metricFormatSchema,
  slices: z.array(
    z.object({ key: z.string(), label: z.string(), value: z.number(), color: colorTokenSchema }),
  ),
  /** The headline in the middle, for example the success rate. */
  center: z.object({ label: z.string(), value: z.number().nullable(), format: metricFormatSchema }),
  note: z.string().nullable(),
});

export const widgetPayloadSchema = z.discriminatedUnion("kind", [
  kpiPayloadSchema,
  seriesPayloadSchema,
  funnelPayloadSchema,
  queuePayloadSchema,
  donutPayloadSchema,
]);
export type WidgetPayload = z.infer<typeof widgetPayloadSchema>;
export type KpiPayload = z.infer<typeof kpiPayloadSchema>;
export type SeriesPayload = z.infer<typeof seriesPayloadSchema>;
export type FunnelPayload = z.infer<typeof funnelPayloadSchema>;
export type QueuePayload = z.infer<typeof queuePayloadSchema>;
export type DonutPayload = z.infer<typeof donutPayloadSchema>;

export const dashboardWidgetResponseSchema = z
  .object({
    id: widgetIdSchema,
    range: dashboardRangeSchema,
    generatedAt: z.date(),
    data: widgetPayloadSchema,
  })
  .meta({ id: "AdminDashboardWidget" });

export const dashboardWidgetParamsSchema = z.object({ id: z.string() });
export const dashboardWidgetQuerySchema = z.object({ range: dashboardRangeSchema.default("30d") });

export const dashboardCatalogItemSchema = z.object({
  id: widgetIdSchema,
  title: z.string(),
  description: z.string(),
  /** Exact definition, shown in the (i) popover and searched by the finder. */
  definition: z.string(),
  group: z.enum(["pipeline", "people", "money", "operations", "trust"]),
  kind: z.enum(["kpi", "series", "funnel", "queue", "donut"]),
  /** Grid columns out of 12. */
  span: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  keywords: z.array(z.string()),
  href: z.string().nullable(),
  defaultOn: z.boolean(),
});

export const dashboardLayoutSchema = z
  .object({
    catalog: z.array(dashboardCatalogItemSchema),
    /** This admin's widgets, in order. */
    widgets: z.array(widgetIdSchema),
    /** True when the admin has never saved a layout (the defaults are shown). */
    isDefault: z.boolean(),
    updatedAt: z.date().nullable(),
  })
  .meta({ id: "AdminDashboardLayout" });
export type DashboardLayoutResponse = z.infer<typeof dashboardLayoutSchema>;

export const MAX_DASHBOARD_WIDGETS = 24;
export const saveDashboardLayoutSchema = z
  .object({
    widgets: z
      .array(widgetIdSchema)
      .min(1)
      .max(MAX_DASHBOARD_WIDGETS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Each widget can appear once.",
      }),
  })
  .meta({ id: "SaveAdminDashboardLayout" });
export type SaveDashboardLayoutInput = z.infer<typeof saveDashboardLayoutSchema>;
