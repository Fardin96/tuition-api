import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminZoneRequestListQuery,
  adminZoneRequestListQuerySchema,
  adminZoneRequestListResponseSchema,
  adminZoneRequestResponseSchema,
  type DecideZoneRequestInput,
  decideZoneRequestSchema,
  type ZoneIdParam,
  zoneIdParamSchema,
} from "../zone/zone.schema.js";
import { decideZoneRequest, listAdminZoneRequests } from "./zone-requests.service.js";

export async function adminZoneRequestRoutes(app: FastifyInstance) {
  // Every response from these routes, including 401/403/404/409, is private and uncacheable.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    return payload;
  });

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List zone-limit requests",
          description:
            "Work queue, oldest first. status defaults to PENDING. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminZoneRequestListQuerySchema,
        response: { 200: adminZoneRequestListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminZoneRequestListQuery;
      const result = await listAdminZoneRequests(query);
      return reply.send(result);
    },
  );

  app.post(
    "/:id/decide",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or deny a zone-limit request",
          description:
            "APPROVE raises the tutor's zone limit to approvedLimit (default: the requested limit). A grant never lowers an existing limit. 409 ZONE_REQUEST_DECIDED when the request is no longer PENDING.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: zoneIdParamSchema,
        body: decideZoneRequestSchema,
        response: { 200: adminZoneRequestResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as ZoneIdParam;
      const body = request.body as DecideZoneRequestInput;
      const updated = await decideZoneRequest(id, body, admin, request.ip);
      return reply.send(updated);
    },
  );
}
