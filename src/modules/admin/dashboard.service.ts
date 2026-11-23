import { notFound } from "../../lib/errors.js";
import type { DashboardRange, WidgetId, WidgetPayload } from "./dashboard.schema.js";
import { bottleneckWidget } from "./dashboard-funnel.js";
import { WIDGET_IDS } from "./dashboard-registry.js";
import { WIDGETS } from "./dashboard-widgets.js";

export type WidgetContext = { range: DashboardRange; now: Date };
export type WidgetComputer = (ctx: WidgetContext) => Promise<WidgetPayload>;

const COMPUTERS: Record<WidgetId, WidgetComputer> = { ...WIDGETS, bottleneck: bottleneckWidget };

// Every admin sees the same numbers, so one per-process cache serves them all.
// shortcut: per-process, so each instance computes its own copy; move to Redis if instances multiply.
const TTL_MS = 60_000;
type Entry = { at: number; promise: Promise<{ generatedAt: Date; data: WidgetPayload }> };
const cache = new Map<string, Entry>();

export function resetDashboardCache() {
  cache.clear();
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

  const promise = COMPUTERS[id]({ range, now }).then((data) => ({ generatedAt: now, data }));
  cache.set(key, { at: now.getTime(), promise });
  // Errors are never cached: the next request tries again.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return { id, range, ...(await promise) };
}
