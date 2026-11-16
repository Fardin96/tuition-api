import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
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
