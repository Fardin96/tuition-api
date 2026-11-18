import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AuditLogListQuery,
  auditLogListQuerySchema,
  auditLogPageSchema,
} from "./audit-logs.schema.js";
import { listAuditLogs } from "./audit-logs.service.js";

export async function adminAuditLogRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List audit log entries",
          description:
            "Newest first. Filter by entityType, entityId, actorAccountId or action. Cursor-paginated (limit 1 to 100, default 50); pass nextCursor back as cursor, and nextCursor is null on the last page.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: auditLogListQuerySchema,
        response: { 200: auditLogPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AuditLogListQuery;
      const page = await listAuditLogs(query);
      return reply.send(page);
    },
  );
}
