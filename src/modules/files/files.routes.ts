import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireAuth, requireRole } from "../../plugins/auth.js";
import { getUploadStatus } from "../admin/uploads.service.js";
import { FILE_POLICY } from "./file-policy.js";
import {
  type CreateUploadUrlInput,
  createUploadUrlSchema,
  downloadUrlSchema,
  type FileIdParam,
  fileAssetSchema,
  fileIdParamSchema,
  uploadStatusSchema,
  uploadUrlSchema,
} from "./files.schema.js";
import { completeUpload, createUploadUrl, deleteFile, getDownloadUrl } from "./files.service.js";

// Upload, complete, read and delete for files. Mounted at /api/v1/files.
export async function fileRoutes(app: FastifyInstance) {
  // Signed URLs must not be cached by browsers or proxies.
  privateNoStore(app);

  app.get(
    "/upload-status",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Check whether my uploads are paused",
          description:
            "Whether an admin has paused video or document uploads for you, and the note when the admin shared it. All false and null when nothing is paused.",
          auth: "any",
          rateLimit: "300/min per account",
        }),
        response: { 200: uploadStatusSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      return reply.send(await getUploadStatus(account.accountId));
    },
  );

  app.post(
    "/upload-url",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Start a file upload",
          description:
            "Reserves a file and returns a signed PUT URL valid for 10 minutes. Send the bytes to uploadUrl with the same Content-Type header, then call complete. Admin-only purposes need an active admin account.",
          auth: "any",
          errors: [409, 503],
          rateLimit: "30/min per account",
        }),
        body: createUploadUrlSchema,
        response: { 201: uploadUrlSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CreateUploadUrlInput;
      const { roles } = FILE_POLICY[body.purpose];
      const account = roles.includes("ADMIN")
        ? await requireAdmin(request)
        : requireRole(request, ...roles);
      return reply.status(201).send(await createUploadUrl(account.accountId, body));
    },
  );

  app.post(
    "/:id/complete",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Confirm an upload",
          description:
            "Call after the PUT to uploadUrl succeeded. Checks the stored size and file signature, then marks the file ready. Calling it again on a finished upload returns the same file.",
          auth: "any",
          errors: [400, 404, 409, 503],
          rateLimit: "60/min per account",
        }),
        params: fileIdParamSchema,
        response: { 200: fileAssetSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as FileIdParam;
      return reply.send(await completeUpload(account.accountId, id));
    },
  );

  app.get(
    "/:id/download-url",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Get a read link for a file",
          description:
            "A short-lived link (5 minutes) for the file's owner or an active admin. Admin views of personal documents are recorded in the audit log.",
          auth: "any",
          errors: [404, 503],
          rateLimit: "300/min per account",
        }),
        params: fileIdParamSchema,
        response: { 200: downloadUrlSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as FileIdParam;
      const isAdmin = await viewerIsAdmin(request);
      return reply.send(
        await getDownloadUrl({ accountId: account.accountId, isAdmin }, id, request.ip),
      );
    },
  );

  app.delete(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Files",
          summary: "Delete a file",
          description:
            "Deletes a file that belongs to you (or any file, for an active admin). A file that a verification, credential, video or blog cover still uses cannot be deleted; remove it there first.",
          auth: "any",
          errors: [404, 409],
          rateLimit: "60/min per account",
          noContent: true,
        }),
        params: fileIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as FileIdParam;
      const isAdmin = await viewerIsAdmin(request);
      await deleteFile(
        { accountId: account.accountId, isAdmin },
        id,
        isAdmin ? { ip: request.ip } : undefined,
      );
      return reply.status(204).send();
    },
  );
}

/** True for an ACTIVE admin. A signed-in non-admin, or a pending or removed admin, is false. */
async function viewerIsAdmin(request: FastifyRequest): Promise<boolean> {
  if (requireAuth(request).role !== "ADMIN") return false;
  try {
    await requireAdmin(request);
    return true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 403) return false;
    throw err;
  }
}
