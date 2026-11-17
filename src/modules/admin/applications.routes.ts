import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminApplicationListQuery,
  adminApplicationListQuerySchema,
  adminApplicationPageSchema,
} from "./applications.schema.js";
import { listAdminApplications } from "./applications.service.js";

export async function adminApplicationRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List applications",
          description:
            "Read-only. Newest first. Filter by status, kind (REQUIREMENT or PACKAGE), tutor and student. Cursor-paginated (limit 1 to 100, default 50). Open GET /api/v1/applications/:id for the full detail.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminApplicationListQuerySchema,
        response: { 200: adminApplicationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminApplicationListQuery;
      const result = await listAdminApplications(query);
      return reply.send(result);
    },
  );
}
