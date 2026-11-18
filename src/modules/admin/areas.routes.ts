import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminAreaListQuery,
  type AreaIdParam,
  adminAreaListQuerySchema,
  adminAreaListSchema,
  adminAreaSchema,
  areaIdParamSchema,
  type CreateAreaInput,
  createAreaSchema,
  type UpdateAreaInput,
  updateAreaSchema,
} from "./areas.schema.js";
import { createArea, listAdminAreas, updateArea } from "./areas.service.js";

export async function adminAreaRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List areas",
          description:
            "Every area, inactive ones included, ordered by division, district then name. tutorCount, studentCount and requirementCount count the tutors, students and requirements that use the area. Filter by districtCode, q (name contains, case-insensitive) and isActive. Not paginated. districts always lists all 64 districts, sorted by division then name, for the create form.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminAreaListQuerySchema,
        response: { 200: adminAreaListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminAreaListQuery;
      const list = await listAdminAreas(query);
      return reply.send(list);
    },
  );

  app.post(
    "/",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Create an area",
          description:
            "division and the district display name come from districtCode. 409 AREA_EXISTS when the name (case-insensitive) is already taken in that district.",
          auth: "admin",
          errors: [409],
          rateLimit: "60/min per account",
        }),
        body: createAreaSchema,
        response: { 201: adminAreaSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const body = request.body as CreateAreaInput;
      const created = await createArea(body, admin, request.ip);
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
          summary: "Update an area",
          description:
            "Renames or activates/deactivates an area. isActive false removes it from GET /areas only; students, tutors and requirements keep it. District and division cannot change. 404 when the area does not exist, 409 AREA_EXISTS when the new name is taken in the same district.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: areaIdParamSchema,
        body: updateAreaSchema,
        response: { 200: adminAreaSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as AreaIdParam;
      const body = request.body as UpdateAreaInput;
      const updated = await updateArea(id, body, admin, request.ip);
      return reply.send(updated);
    },
  );
}
