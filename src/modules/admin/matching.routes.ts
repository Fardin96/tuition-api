import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import type { MatchingConfigInput } from "../matching/matching-config.js";
import {
  adminCityListSchema,
  adminCitySchema,
  type CitySlugParam,
  citySlugParamSchema,
  type MatchingExplainQuery,
  type MatchingPreviewRequest,
  type MatchingUnmatchedQuery,
  matchingConfigBodySchema,
  matchingConfigRecordSchema,
  matchingExplainQuerySchema,
  matchingExplainSchema,
  matchingPreviewPairSchema,
  matchingPreviewRequestSchema,
  matchingUnmatchedQuerySchema,
  matchingUnmatchedSchema,
  type UpdateCityInput,
  type UpsertCityInput,
  updateCitySchema,
  upsertCitySchema,
} from "./matching.schema.js";
import {
  explainAdminMatch,
  getAdminMatchingConfig,
  listCities,
  listUnmatchedRequirements,
  previewAdminMatching,
  saveAdminMatchingConfig,
  setCityActive,
  upsertCity,
} from "./matching.service.js";

// Registered under /api/v1/admin, so the paths below are full: /matching/* and /cities/*.
export async function adminMatchingRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/matching/config",
    {
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Get the matching rules",
          description:
            "The saved rules with their version, the defaults, and the modes each rule accepts. A config nobody has saved yet shows the defaults at version 0.",
          auth: "admin",
        }),
        response: { 200: matchingConfigRecordSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      return reply.send(await getAdminMatchingConfig());
    },
  );

  app.put(
    "/matching/config",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Save the matching rules",
          description:
            "Super admin only. Every save bumps the version; match responses and applications carry it. 400 VALIDATION_ERROR when a rule has a mode it cannot take, a curriculum is in two equivalence groups, or every ranked rule has weight 0.",
          auth: "admin",
          errors: [400],
          rateLimit: "60/min per account",
        }),
        body: matchingConfigBodySchema,
        response: { 200: matchingConfigRecordSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const body = request.body as MatchingConfigInput;
      return reply.send(await saveAdminMatchingConfig(body, admin, request.ip));
    },
  );

  app.post(
    "/matching/preview",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Preview a draft config",
          description:
            "Counts open requirements and listed tutors under the saved config (current) and under the posted one (draft). Nothing is saved. Both share the saved version number.",
          auth: "admin",
          errors: [400],
          rateLimit: "10/min per account",
        }),
        body: matchingPreviewRequestSchema,
        response: { 200: matchingPreviewPairSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { config } = request.body as MatchingPreviewRequest;
      return reply.send(await previewAdminMatching(config));
    },
  );

  app.get(
    "/matching/explain",
    {
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Explain one requirement and tutor pair",
          description:
            "Every active set of the tutor against the requirement, best first, with each rule's mode, pass and part. Ignores whether the tutor is listed, so it also explains an unlisted tutor. 404 when the requirement or the tutor does not exist.",
          auth: "admin",
          errors: [400, 404],
        }),
        querystring: matchingExplainQuerySchema,
        response: { 200: matchingExplainSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { requirementId, tutorId } = request.query as MatchingExplainQuery;
      return reply.send(await explainAdminMatch(requirementId, tutorId));
    },
  );

  app.get(
    "/matching/unmatched",
    {
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "List open requirements with no matching tutor",
          description:
            "OPEN requirements older than olderThanHours with no listed tutor that matches, oldest first. blockers names the rules that alone keep each one empty; empty when it needs more than one change.",
          auth: "admin",
          errors: [400],
        }),
        querystring: matchingUnmatchedQuerySchema,
        response: { 200: matchingUnmatchedSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { olderThanHours, limit } = request.query as MatchingUnmatchedQuery;
      return reply.send(await listUnmatchedRequirements(olderThanHours, limit));
    },
  );

  app.get(
    "/cities",
    {
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "List cities",
          description:
            "Every city, inactive ones included, with the area of its boundary in km2. Dhaka is seeded by migration.",
          auth: "admin",
        }),
        response: { 200: adminCityListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      return reply.send({ cities: await listCities() });
    },
  );

  app.put(
    "/cities/:slug",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Create or replace a city",
          description:
            "Super admin only. The boundary is GeoJSON Polygon or MultiPolygon in lng/lat. 400 VALIDATION_ERROR (path boundary) when it is not a valid polygon, crosses itself, or covers less than 5 or more than 2000 km2. isActive is kept when omitted.",
          auth: "admin",
          errors: [400],
          rateLimit: "20/min per account",
        }),
        params: citySlugParamSchema,
        body: upsertCitySchema,
        response: { 200: adminCitySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { slug } = request.params as CitySlugParam;
      const body = request.body as UpsertCityInput;
      return reply.send(await upsertCity(slug, body, admin, request.ip));
    },
  );

  app.patch(
    "/cities/:slug",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin Matching",
          summary: "Activate or deactivate a city",
          description:
            "Super admin only. An inactive city is not used for the city limit. 404 when the city does not exist.",
          auth: "admin",
          errors: [400, 404],
          rateLimit: "20/min per account",
        }),
        params: citySlugParamSchema,
        body: updateCitySchema,
        response: { 200: adminCitySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { slug } = request.params as CitySlugParam;
      const { isActive } = request.body as UpdateCityInput;
      return reply.send(await setCityActive(slug, isActive, admin, request.ip));
    },
  );
}
