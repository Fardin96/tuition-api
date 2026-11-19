import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateReviewInput,
  createReviewSchema,
  type MyReviewListQuery,
  myReviewListQuerySchema,
  myReviewPageSchema,
  myReviewSchema,
  type ReviewIdParam,
  reviewIdParamSchema,
  type UpdateReviewInput,
  updateReviewSchema,
} from "./review.schema.js";
import { createReview, listMyReviews, updateReview } from "./review.service.js";

// Reviews written by the signed-in student or tutor, mounted at /api/v1/reviews.
export async function reviewRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Reviews",
          summary: "Review the other side of a tuition",
          description:
            "A student reviews the tutor, a tutor reviews the student. The application must be CONFIRMED or COMPLETED (409 REVIEW_NOT_ALLOWED otherwise) and you must be one of its two parties (404 otherwise). One review per tutor and student pair and direction: 409 REVIEW_EXISTS.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404, 409],
          rateLimit: "20/min per account",
        }),
        body: createReviewSchema,
        response: { 201: myReviewSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const body = request.body as CreateReviewInput;
      return reply.status(201).send(await createReview(account, body));
    },
  );

  app.get(
    "/mine",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Reviews",
          summary: "List the reviews I wrote",
          description:
            "Newest first, cursor-paginated (limit 1 to 100, default 25). Includes hidden reviews with status HIDDEN. applicationId returns the review for that application's tutor and student pair (at most one); 404 when you are not a party of it.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        querystring: myReviewListQuerySchema,
        response: { 200: myReviewPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const query = request.query as MyReviewListQuery;
      return reply.send(await listMyReviews(account, query));
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(20, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Reviews",
          summary: "Edit my review",
          description:
            "Only the author can edit, for 30 days after writing it (409 REVIEW_NOT_ALLOWED). A review hidden by an admin cannot be edited (409 INVALID_REVIEW_STATE). Send a rating, a comment (null clears it), or both.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404, 409],
          rateLimit: "20/min per account",
        }),
        params: reviewIdParamSchema,
        body: updateReviewSchema,
        response: { 200: myReviewSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const { id } = request.params as ReviewIdParam;
      const body = request.body as UpdateReviewInput;
      return reply.send(await updateReview(account, id, body));
    },
  );
}
