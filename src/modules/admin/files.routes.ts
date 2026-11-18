import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import { deleteFile } from "../files/files.service.js";
import {
  type AdminFileIdParam,
  type AdminFileListQuery,
  adminFileIdParamSchema,
  adminFileListQuerySchema,
  adminFilePageSchema,
  adminFileStatsSchema,
} from "./files.schema.js";
import { getAdminFileStats, listAdminFiles } from "./files.service.js";

export async function adminFileRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List uploaded files",
          description:
            "Every upload, newest first. Filters: purpose, status, ownerAccountId, unattached=true for files no record uses (unattached=false for files in use). Each file says whether it is published and whether a record uses it. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminFileListQuerySchema,
        response: { 200: adminFilePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminFileListQuery;
      return reply.send(await listAdminFiles(query));
    },
  );

  app.get(
    "/stats",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Count uploaded files and their size",
          description: "Count and total bytes for each purpose and status.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminFileStatsSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      return reply.send(await getAdminFileStats());
    },
  );

  app.delete(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Delete an uploaded file",
          description:
            "Deletes any file and its stored copies. 409 FILE_IN_USE while a record uses it: remove the record first. Audited. Replies 204 with no body.",
          auth: "admin",
          errors: [404, 409],
          noContent: true,
          rateLimit: "60/min per account",
        }),
        params: adminFileIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as AdminFileIdParam;
      await deleteFile({ accountId: admin.accountId, isAdmin: true }, id, { ip: request.ip });
      return reply.status(204).send();
    },
  );
}
