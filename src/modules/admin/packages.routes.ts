import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import { type PackageIdParam, packageIdParamSchema } from "../package/package.schema.js";
import {
  type AdminPackageListQuery,
  adminPackageListQuerySchema,
  adminPackagePageSchema,
  adminPackageSchema,
  type ModeratePackageInput,
  moderatePackageSchema,
} from "./packages.schema.js";
import { getAdminPackage, listAdminPackages, moderatePackage } from "./packages.service.js";

export async function adminPackageRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List packages for moderation",
          description:
            "moderationStatus defaults to PENDING, the work queue, oldest first. APPROVED and REJECTED are newest first. Optional status filters the listing status. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminPackageListQuerySchema,
        response: { 200: adminPackagePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminPackageListQuery;
      return reply.send(await listAdminPackages(query));
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get one package for moderation",
          description:
            "Any package, whatever its moderation or listing status. Includes the moderation note and the tutor's verification and listing state.",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: packageIdParamSchema,
        response: { 200: adminPackageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as PackageIdParam;
      return reply.send(await getAdminPackage(id));
    },
  );

  app.post(
    "/:id/moderate",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a package",
          description:
            "APPROVE makes the package visible to students. REJECT needs a note that tells the tutor why. The tutor can edit a rejected package, which resubmits it as PENDING. 409 PACKAGE_ALREADY_MODERATED when the package is no longer PENDING.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: packageIdParamSchema,
        body: moderatePackageSchema,
        response: { 200: adminPackageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as PackageIdParam;
      const body = request.body as ModeratePackageInput;
      return reply.send(await moderatePackage(id, body, admin, request.ip));
    },
  );
}
