import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type PackageBrowseQuery,
  type PackageIdParam,
  packageBrowseQuerySchema,
  packageIdParamSchema,
  packagePageSchema,
  packageSchema,
} from "./package.schema.js";
import { browsePackages, getPackageForCaller } from "./package.service.js";

export async function packageRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "Browse tuition packages",
          description:
            "Student browse (#52). Packages are APPROVED, OPEN, from listed tutors. scope=nearby keeps online packages plus packages whose tutor has a zone covering the student pin. Without a usable pin, nearby falls back to online packages and the student's area, and locationMissing is true. scope=all skips the location match. Filters: curriculum, levelCode, subjectId. Newest first, keyset cursor.",
          auth: ["STUDENT"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        querystring: packageBrowseQuerySchema,
        response: {
          200: packagePageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const query = request.query as PackageBrowseQuery;
      const page = await browsePackages(account.accountId, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "Get one package",
          description:
            "Package detail (#54). STUDENT sees APPROVED packages only. TUTOR sees its own packages in any state. ADMIN (ACTIVE admin_user) sees any package. myApplication is set only for the calling student.",
          auth: ["STUDENT", "TUTOR", "ADMIN"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: packageIdParamSchema,
        response: {
          200: packageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR", "ADMIN");
      const { id } = request.params as PackageIdParam;
      const pkg = await getPackageForCaller(id, account);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(pkg);
    },
  );
}
