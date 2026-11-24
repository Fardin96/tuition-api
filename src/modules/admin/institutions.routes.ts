import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireSuperAdmin } from "../../plugins/auth.js";
import {
  adminInstitutionListSchema,
  adminInstitutionSchema,
  type CreateInstitutionInput,
  createInstitutionSchema,
  type InstitutionIdParam,
  type InstitutionListQuery,
  institutionIdParamSchema,
  institutionListQuerySchema,
  type UpdateInstitutionInput,
  updateInstitutionSchema,
} from "./institutions.schema.js";
import { createInstitution, listInstitutions, updateInstitution } from "./institutions.service.js";

export async function adminInstitutionRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List schools and universities",
          description:
            "Super admin only. Every institution, inactive ones included, ordered by name then id. q matches the search text, an alias or the EIIN. status is active, inactive or all (default all). total counts the rows that match the filters.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: institutionListQuerySchema,
        response: { 200: adminInstitutionListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireSuperAdmin(request);
      const result = await listInstitutions(request.query as InstitutionListQuery);
      return reply.send(result);
    },
  );

  app.post(
    "/",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Add a school or university",
          description:
            "Super admin only. 409 INSTITUTION_EXISTS when another row has the same name in the same area (the area is compared case-insensitively; no area counts as one).",
          auth: "admin",
          errors: [409],
          rateLimit: "60/min per account",
        }),
        body: createInstitutionSchema,
        response: { 201: adminInstitutionSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const created = await createInstitution(
        request.body as CreateInstitutionInput,
        admin,
        request.ip,
      );
      return reply.code(201).send(created);
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Update a school or university",
          description:
            "Super admin only. Renames, re-kinds, re-areas, replaces the aliases or sets isActive. A rename also sets the name on every tutor and requirement linked to the row. isActive false hides the row from search; links keep their text. 404 when it does not exist, 409 INSTITUTION_EXISTS on a duplicate.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: institutionIdParamSchema,
        body: updateInstitutionSchema,
        response: { 200: adminInstitutionSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { id } = request.params as InstitutionIdParam;
      const updated = await updateInstitution(
        id,
        request.body as UpdateInstitutionInput,
        admin,
        request.ip,
      );
      return reply.send(updated);
    },
  );
}
