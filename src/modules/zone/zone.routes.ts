import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "../../lib/errors.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateZoneInput,
  type CreateZoneLimitRequestInput,
  createZoneLimitRequestSchema,
  createZoneSchema,
  type UpdateZoneInput,
  updateZoneSchema,
  type ZoneIdParam,
  type ZoneLimitRequestListQuery,
  zoneDeleteResponseSchema,
  zoneIdParamSchema,
  zoneLimitRequestListQuerySchema,
  zoneLimitRequestListResponseSchema,
  zoneLimitRequestResponseSchema,
  zoneListResponseSchema,
  zoneResponseSchema,
} from "./zone.schema.js";
import {
  createZone,
  createZoneLimitRequest,
  deleteZone,
  listZoneLimitRequests,
  listZones,
  updateZone,
} from "./zone.service.js";

const TUTOR_PROFILE_NOT_FOUND = "Tutor profile not found";

export async function zoneRoutes(app: FastifyInstance) {
  app.get(
    "/zones",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: { response: { 200: zoneListResponseSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const result = await listZones(account.accountId);
      if (!result) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );

  app.post(
    "/zones",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: { body: createZoneSchema, response: { 201: zoneResponseSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateZoneInput;
      const zone = await createZone(account.accountId, body);
      if (!zone) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(zone);
    },
  );

  app.patch(
    "/zones/:id",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        params: zoneIdParamSchema,
        body: updateZoneSchema,
        response: { 200: zoneResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as ZoneIdParam;
      const body = request.body as UpdateZoneInput;
      const zone = await updateZone(account.accountId, id, body);
      if (!zone) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(zone);
    },
  );

  app.delete(
    "/zones/:id",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        params: zoneIdParamSchema,
        response: { 200: zoneDeleteResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as ZoneIdParam;
      const result = await deleteZone(account.accountId, id);
      if (!result) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );

  app.post(
    "/zone-limit-requests",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        body: createZoneLimitRequestSchema,
        response: { 201: zoneLimitRequestResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateZoneLimitRequestInput;
      const created = await createZoneLimitRequest(account.accountId, body);
      if (!created) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/zone-limit-requests",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        querystring: zoneLimitRequestListQuerySchema,
        response: { 200: zoneLimitRequestListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const query = request.query as ZoneLimitRequestListQuery;
      const result = await listZoneLimitRequests(account.accountId, query);
      if (!result) throw notFound(TUTOR_PROFILE_NOT_FOUND);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );
}
