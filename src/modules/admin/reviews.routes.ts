import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminReviewListQuery,
  adminReviewListQuerySchema,
  adminReviewPageSchema,
  adminReviewSchema,
  type ModerateReviewInput,
  moderateReviewSchema,
  type ReviewIdParam,
  reviewIdParamSchema,
} from "./reviews.schema.js";
import { listAdminReviews, moderateReview } from "./reviews.service.js";

// Reviews for moderation, mounted at /api/v1/admin/reviews.
export async function adminReviewRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List reviews",
          description:
            "Every review, newest first, hidden ones included. Filter by status, direction, tutorId, studentId or rating. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminReviewListQuerySchema,
        response: { 200: adminReviewPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminReviewListQuery;
      return reply.send(await listAdminReviews(query));
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Hide or restore a review",
          description:
            "HIDDEN takes the review off public profiles and out of the rating average; VISIBLE restores it. The note is kept in the audit log. 409 INVALID_REVIEW_STATE when the review already has that status.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: reviewIdParamSchema,
        body: moderateReviewSchema,
        response: { 200: adminReviewSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as ReviewIdParam;
      const body = request.body as ModerateReviewInput;
      return reply.send(await moderateReview(id, body, admin, request.ip));
    },
  );
}
