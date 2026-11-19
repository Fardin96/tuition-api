import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  adminStudentVerificationPageSchema,
  adminStudentVerificationSchema,
  adminTutorVerificationPageSchema,
  adminTutorVerificationSchema,
  type DecideVerificationInput,
  decideVerificationSchema,
  type VerificationIdParam,
  type VerificationListQuery,
  verificationIdParamSchema,
  verificationListQuerySchema,
} from "./verifications.schema.js";
import {
  decideStudentVerification,
  decideTutorVerification,
  listStudentVerifications,
  listTutorVerifications,
} from "./verifications.service.js";

// Student and tutor ID reviews, mounted at /api/v1/admin/verifications.
export async function adminVerificationRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/tutors",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List tutor ID submissions",
          description:
            "status defaults to PENDING, the work queue, oldest first. APPROVED and REJECTED are newest first. Cursor-paginated (limit 1 to 100, default 25). Each row has isLatest (only the tutor's newest submission can be decided), noteVisible (false when the note is for admins only) and uploadFlags (rejections, revocations and removals in the last 30 days, and whether uploads are blocked).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: verificationListQuerySchema,
        response: { 200: adminTutorVerificationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as VerificationListQuery;
      return reply.send(await listTutorVerifications(query));
    },
  );

  app.post(
    "/tutors/:id/decide",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a tutor ID submission",
          description:
            "The id is the verification (submission) id from the list. Only the tutor's newest submission can be decided. APPROVE sets it APPROVED and needs the file still uploaded. REJECT sets it REJECTED and needs a note that tells the tutor why. Allowed moves: PENDING to APPROVED or REJECTED, REJECTED to APPROVED, and APPROVED to REJECTED (a revocation, which also sets the tutor REJECTED). The note is shared with the tutor when noteVisible is true (the default); otherwise the tutor gets a generic alert. The decision is recorded in the upload history and sent as an alert. 409 INVALID_VERIFICATION_STATE when the submission is not the latest, already has that decision, or its file was removed.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: verificationIdParamSchema,
        body: decideVerificationSchema,
        response: { 200: adminTutorVerificationSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as VerificationIdParam;
      const body = request.body as DecideVerificationInput;
      return reply.send(await decideTutorVerification(id, body, admin, request.ip));
    },
  );

  app.get(
    "/students",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List student ID submissions",
          description:
            "status defaults to PENDING, the work queue, oldest submission first. APPROVED and REJECTED are newest first. Cursor-paginated (limit 1 to 100, default 25). Each row has noteVisible and uploadFlags.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: verificationListQuerySchema,
        response: { 200: adminStudentVerificationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as VerificationListQuery;
      return reply.send(await listStudentVerifications(query));
    },
  );

  app.post(
    "/students/:id/decide",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a student ID submission",
          description:
            "The id is the student id. APPROVE makes the student verified and needs the file still uploaded. REJECT needs a note that tells the student why. Allowed moves: PENDING to APPROVED or REJECTED, REJECTED to APPROVED, and APPROVED to REJECTED (a revocation). The note is shared with the student when noteVisible is true (the default); otherwise the student gets a generic alert. The decision is recorded in the upload history and sent as an alert. 409 INVALID_VERIFICATION_STATE when there is no submission, the decision is already set, or the file was removed.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: verificationIdParamSchema,
        body: decideVerificationSchema,
        response: { 200: adminStudentVerificationSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as VerificationIdParam;
      const body = request.body as DecideVerificationInput;
      return reply.send(await decideStudentVerification(id, body, admin, request.ip));
    },
  );
}
