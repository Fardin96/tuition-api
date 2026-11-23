import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { DashboardRange, WidgetId, WidgetPayload } from "./dashboard.schema.js";
import { bottleneckWidget } from "./dashboard-funnel.js";
import { WIDGET_IDS } from "./dashboard-registry.js";
import { WIDGETS } from "./dashboard-widgets.js";

export type WidgetContext = { range: DashboardRange; now: Date; since?: Date };
export type WidgetComputer = (ctx: WidgetContext) => Promise<WidgetPayload>;

const COMPUTERS: Record<WidgetId, WidgetComputer> = { ...WIDGETS, bottleneck: bottleneckWidget };

// Every admin sees the same numbers, so one per-process cache serves them all.
// shortcut: per-process, so each instance computes its own copy; move to Redis if instances multiply.
const TTL_MS = 60_000;
type Entry = { at: number; promise: Promise<{ generatedAt: Date; data: WidgetPayload }> };
const cache = new Map<string, Entry>();
// The earliest student or tutor signup, for "all time". Cached like the widgets, under its own key.
type SinceEntry = { at: number; promise: Promise<Date | undefined> };
let sinceEntry: SinceEntry | undefined;

export function resetDashboardCache() {
  cache.clear();
  sinceEntry = undefined;
}

async function earliestSignup(now: Date): Promise<Date | undefined> {
  if (sinceEntry && now.getTime() - sinceEntry.at < TTL_MS) return sinceEntry.promise;
  const promise = prisma.account
    .aggregate({ where: { role: { in: ["STUDENT", "TUTOR"] } }, _min: { createdAt: true } })
    .then((row) => row._min.createdAt ?? undefined);
  const entry: SinceEntry = { at: now.getTime(), promise };
  sinceEntry = entry;
  promise.catch(() => {
    if (sinceEntry === entry) sinceEntry = undefined;
  });
  return promise;
}

export function isWidgetId(id: string): id is WidgetId {
  return (WIDGET_IDS as readonly string[]).includes(id);
}

export async function getWidget(id: string, range: DashboardRange, now = new Date()) {
  if (!isWidgetId(id)) throw notFound("Widget not found");
  const key = `${id}:${range}`;
  const hit = cache.get(key);
  // A pending promise is shared too (single-flight), so concurrent admins run one query.
  if (hit && now.getTime() - hit.at < TTL_MS) return { id, range, ...(await hit.promise) };

  const since = range === "all" ? await earliestSignup(now) : undefined;
  const promise = COMPUTERS[id]({ range, now, since }).then((data) => ({ generatedAt: now, data }));
  cache.set(key, { at: now.getTime(), promise });
  // Errors are never cached: the next request tries again.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return { id, range, ...(await promise) };
}
