import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreatePackageInput,
  createPackageSchema,
  myPackageListSchema,
  type PackageBrowseQuery,
  type PackageIdParam,
  packageBrowseQuerySchema,
  packageIdParamSchema,
  packagePageSchema,
  packageSchema,
  type UpdatePackageInput,
  updatePackageSchema,
} from "./package.schema.js";
import {
  browsePackages,
  closePackage,
  createPackage,
  getPackageForCaller,
  listMyPackages,
  updatePackage,
} from "./package.service.js";

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
            "Student browse (#52). Packages are APPROVED, OPEN, from listed tutors. A filter matches when the package covers it: curriculum is one of its curricula, levelCode is inside its level range, subjectId is one of its subjects. scope=nearby keeps online packages plus packages with one of their own zones covering the student pin. Without a usable pin, nearby keeps online packages only and locationMissing is true. scope=all skips the location match. Newest first, keyset cursor.",
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

  app.post(
    "/",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "Create a package",
          description:
            "#51. A tutor publishes a package offer: title, what it covers, duration in weeks and the total price in BDT. The placement fee is a percentage of that price. It goes live right away (admin moderation is not built yet). Fails with 403 PROFILE_INCOMPLETE until the profile passes the apply gate; the default requirement set is not needed. Fails with 400 INVALID_REQUIREMENT (fields subjectIds or zoneIds) when a subject is not on the profile or a zone is not one of the tutor's zones. The package needs a zone or teachesOnline (400 VALIDATION_ERROR on zoneIds). syncProfileSubjects adds missing subjects to the profile in the same transaction.",
          auth: ["TUTOR"],
          errors: [403, 404],
          rateLimit: "60/min per account",
        }),
        body: createPackageSchema,
        response: {
          201: packageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreatePackageInput;
      const pkg = await createPackage(account, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(pkg);
    },
  );

  app.get(
    "/mine",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "List my packages",
          description:
            "#53. The tutor's own packages in any state, newest first, at most 100. Each one lists its subjectIds and zoneIds, with request counts.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        response: {
          200: myPackageListSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const list = await listMyPackages(account);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(list);
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

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "Edit my package",
          description:
            "#55. Partial edit of an OPEN package. The merged values are checked with the same rules as create (400 VALIDATION_ERROR with issues, one per field). subjectIds and zoneIds replace the lists when sent, and subjects must be on the profile and zones must be the tutor's own. Clearing every zone needs teachesOnline. Price is the total for the package. daysPerWeek accepts null to clear. Moderation is not reset. Students with a pending or confirmed request get a PACKAGE_UPDATED alert. 409 LISTING_NOT_OPEN when the package is not OPEN.",
          auth: ["TUTOR"],
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: packageIdParamSchema,
        body: updatePackageSchema,
        response: {
          200: packageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as PackageIdParam;
      const body = request.body as UpdatePackageInput;
      const pkg = await updatePackage(account, id, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(pkg);
    },
  );

  app.post(
    "/:id/close",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Packages",
          summary: "Close my package",
          description:
            "#56. OPEN to CLOSED. Pending requests become EXPIRED and those students get a PACKAGE_CLOSED alert. Confirmed placements are not affected. 409 LISTING_NOT_OPEN when already closed.",
          auth: ["TUTOR"],
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: packageIdParamSchema,
        response: {
          200: packageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as PackageIdParam;
      const pkg = await closePackage(account, id);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(pkg);
    },
  );
}
