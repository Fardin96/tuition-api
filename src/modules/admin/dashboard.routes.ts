import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type DashboardRange,
  dashboardLayoutSchema,
  dashboardWidgetParamsSchema,
  dashboardWidgetQuerySchema,
  dashboardWidgetResponseSchema,
  type SaveDashboardLayoutInput,
  saveDashboardLayoutSchema,
} from "./dashboard.schema.js";
import { getWidget } from "./dashboard.service.js";
import { getLayout, resetLayout, saveLayout } from "./dashboard-layout.js";

// The admin business dashboard, mounted at /api/v1/admin/dashboard. Any active admin.
// The layout is the caller's own: the account id always comes from the session, never a param.
export async function adminDashboardRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/layout",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get your dashboard layout",
          description:
            "The widget catalog and the calling admin's widgets in order. Admins who never saved a layout get the defaults (isDefault true). Widgets no longer in the catalog are dropped.",
          auth: "admin",
          rateLimit: "120/min per account",
        }),
        response: { 200: dashboardLayoutSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      return reply.send(await getLayout(admin.accountId));
    },
  );

  app.put(
    "/layout",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Save your dashboard layout",
          description:
            "Replaces the calling admin's widgets with this ordered list (1 to 24 known ids, no repeats).",
          auth: "admin",
          rateLimit: "60/min per account",
        }),
        body: saveDashboardLayoutSchema,
        response: { 200: dashboardLayoutSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      return reply.send(
        await saveLayout(admin.accountId, request.body as SaveDashboardLayoutInput),
      );
    },
  );

  app.delete(
    "/layout",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Reset your dashboard layout",
          description: "Deletes the calling admin's saved layout, so the defaults show again.",
          auth: "admin",
          rateLimit: "60/min per account",
        }),
        response: { 200: dashboardLayoutSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      return reply.send(await resetLayout(admin.accountId));
    },
  );

  app.get(
    "/widgets/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get one dashboard widget",
          description:
            "The data for one widget over a range (7d, 30d, 90d or 12m; default 30d), in Asia/Dhaka days or months. Cached for 60 seconds and shared by all admins. Unknown id: 404.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        params: dashboardWidgetParamsSchema,
        querystring: dashboardWidgetQuerySchema,
        response: { 200: dashboardWidgetResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as { id: string };
      const { range } = request.query as { range: DashboardRange };
      return reply.send(await getWidget(id, range));
    },
  );
}
