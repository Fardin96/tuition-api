import { prisma } from "../../lib/prisma.js";
import type {
  DashboardLayoutResponse,
  SaveDashboardLayoutInput,
  WidgetId,
} from "./dashboard.schema.js";
import { CATALOG, DEFAULT_WIDGETS, WIDGET_IDS } from "./dashboard-registry.js";

const KNOWN = new Set<string>(WIDGET_IDS);

// Stored ids can outlive a catalog change, so unknown and repeated ids are dropped on every read.
export async function getLayout(accountId: string): Promise<DashboardLayoutResponse> {
  const row = await prisma.adminDashboardLayout.findUnique({ where: { accountId } });
  const saved = Array.isArray(row?.widgets) ? (row.widgets as unknown[]) : [];
  const widgets = [...new Set(saved.filter((id): id is string => typeof id === "string"))].filter(
    (id): id is WidgetId => KNOWN.has(id),
  );
  const isDefault = widgets.length === 0;
  return {
    catalog: [...CATALOG],
    widgets: isDefault ? DEFAULT_WIDGETS : widgets,
    isDefault,
    updatedAt: isDefault ? null : (row?.updatedAt ?? null),
  };
}

export async function saveLayout(
  accountId: string,
  input: SaveDashboardLayoutInput,
): Promise<DashboardLayoutResponse> {
  await prisma.adminDashboardLayout.upsert({
    where: { accountId },
    create: { accountId, widgets: input.widgets },
    update: { widgets: input.widgets },
  });
  return getLayout(accountId);
}

export async function resetLayout(accountId: string): Promise<DashboardLayoutResponse> {
  await prisma.adminDashboardLayout.deleteMany({ where: { accountId } });
  return getLayout(accountId);
}
