import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type LiftUploadBlockInput,
  liftUploadBlockSchema,
  type UploadAccountParam,
  type UploadBlockInput,
  type UploadHistoryQuery,
  uploadAccountParamSchema,
  uploadBlockBodySchema,
  uploadBlockViewSchema,
  uploadHistoryQuerySchema,
  uploadHistorySchema,
} from "./uploads.schema.js";
import { getUploadHistory, liftUploadBlock, setUploadBlock } from "./uploads.service.js";

// Upload history and blocks for one account. Mounted at /api/v1/admin/accounts.
export async function adminUploadRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/:accountId/uploads",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Upload history for an account",
          description:
            "The account's active upload block (or null), a summary and its upload history, newest first. A rejection, revocation or removal counts as an issue for 30 days; three or more issues show a repeated-problems warning. Admin views include hidden notes. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: uploadAccountParamSchema,
        querystring: uploadHistoryQuerySchema,
        response: { 200: uploadHistorySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { accountId } = request.params as UploadAccountParam;
      const query = request.query as UploadHistoryQuery;
      return reply.send(await getUploadHistory(accountId, query));
    },
  );

  app.put(
    "/:accountId/upload-block",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Pause uploads for an account",
          description:
            "Blocks video uploads, document uploads (IDs and certificates) or both, with a note. Creates the active block or updates it. The account is told, and the note shows to them only when noteVisible is true. Admin accounts cannot be blocked. Audited.",
          auth: "admin",
          errors: [404],
          rateLimit: "60/min per account",
        }),
        params: uploadAccountParamSchema,
        body: uploadBlockBodySchema,
        response: { 200: uploadBlockViewSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { accountId } = request.params as UploadAccountParam;
      const body = request.body as UploadBlockInput;
      return reply.send(await setUploadBlock(accountId, body, caller, request.ip));
    },
  );

  app.post(
    "/:accountId/upload-block/lift",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Lift an upload block",
          description:
            "Closes the account's active upload block. The note is optional; the account is told, and it shows to them only when a note is given and noteVisible is true. 404 when nothing is blocked. Audited. Replies 204 with no body.",
          auth: "admin",
          errors: [404],
          noContent: true,
          rateLimit: "60/min per account",
        }),
        params: uploadAccountParamSchema,
        body: liftUploadBlockSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { accountId } = request.params as UploadAccountParam;
      // No body means no note; the note default only applies when a body was sent.
      const body: LiftUploadBlockInput = {
        noteVisible: true,
        ...(request.body as LiftUploadBlockInput | null),
      };
      await liftUploadBlock(accountId, body, caller, request.ip);
      return reply.status(204).send();
    },
  );
}
