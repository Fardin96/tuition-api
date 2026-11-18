import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminVideoListQuery,
  adminVideoListQuerySchema,
  adminVideoPageSchema,
  adminVideoSchema,
  type ModerateVideoInput,
  moderateVideoSchema,
  type UpdateVideoInput,
  updateVideoSchema,
  type VideoIdParam,
  videoIdParamSchema,
} from "./videos.schema.js";
import { listAdminVideos, moderateVideo, updateVideo } from "./videos.service.js";

// Tutor videos for review, mounted at /api/v1/admin/videos.
export async function adminVideoRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List tutor videos for review",
          description:
            "status defaults to PENDING, the work queue, oldest first. APPROVED and REJECTED are newest first. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminVideoListQuerySchema,
        response: { 200: adminVideoPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminVideoListQuery;
      return reply.send(await listAdminVideos(query));
    },
  );

  app.post(
    "/:id/moderate",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a tutor video",
          description:
            "APPROVE publishes the video to students. REJECT needs a note that tells the tutor why, and takes an approved video down. 409 VIDEO_ALREADY_MODERATED when the video already has that decision.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: videoIdParamSchema,
        body: moderateVideoSchema,
        response: { 200: adminVideoSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as VideoIdParam;
      const body = request.body as ModerateVideoInput;
      return reply.send(await moderateVideo(id, body, admin, request.ip));
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Set a tutor video's display order",
          description: "Lower sortOrder shows first.",
          auth: "admin",
          errors: [404],
          rateLimit: "60/min per account",
        }),
        params: videoIdParamSchema,
        body: updateVideoSchema,
        response: { 200: adminVideoSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as VideoIdParam;
      const body = request.body as UpdateVideoInput;
      return reply.send(await updateVideo(id, body, admin, request.ip));
    },
  );
}
