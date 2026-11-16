import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAuth, requireRole } from "../../plugins/auth.js";
import {
  type StudentIdParam,
  type StudentProfileInput,
  studentIdParamSchema,
  studentProfileSchema,
  studentPublicProfileSchema,
  studentResponseSchema,
  studentReviewListSchema,
  type UpdateStudentProfileInput,
  updateStudentProfileSchema,
} from "./student.schema.js";
import {
  createStudentProfile,
  getStudentById,
  getStudentReviews,
  hasSharedApplication,
  updateStudentProfile,
} from "./student.service.js";

export async function studentRoutes(app: FastifyInstance) {
  app.post(
    "/me",
    {
      schema: {
        ...routeDocs({
          tag: "Students",
          summary: "Create my student profile",
          description:
            "Creates the signed-in student's profile. 409 when a profile already exists or when a phone or WhatsApp number belongs to another account.",
          auth: ["STUDENT"],
          errors: [409],
        }),
        body: studentProfileSchema,
        response: { 201: studentResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const body = request.body as StudentProfileInput;
      const profile = await createStudentProfile(account.accountId, body);
      return reply.status(201).send(profile);
    },
  );

  app.patch(
    "/me",
    {
      schema: {
        ...routeDocs({
          tag: "Students",
          summary: "Update my student profile",
          description:
            "Send any subset of the profile fields. whatsappNumber null clears it. 409 when a phone or WhatsApp number belongs to another account.",
          auth: ["STUDENT"],
          errors: [404, 409],
        }),
        body: updateStudentProfileSchema,
        response: { 200: studentResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const body = request.body as UpdateStudentProfileInput;
      const profile = await updateStudentProfile(account.accountId, body);
      if (!profile) throw notFound("Student profile not found");
      return reply.send(profile);
    },
  );

  // Deferred: requires file upload / presigned URL flow.
  app.post(
    "/me/verification",
    {
      schema: {
        ...routeDocs({
          tag: "Students",
          summary: "Submit my ID for verification",
          description: "Not built yet. Always answers 501 until the storage module lands.",
          auth: ["STUDENT"],
          deferred: true,
        }),
      },
    },
    async () => {
      throw appError(
        "NotImplemented",
        501,
        "File upload endpoint deferred until the storage module is implemented",
      );
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Students",
          summary: "Get a student's public profile",
          description:
            "Name, area and rating. Students cannot view other students (403). A tutor needs a shared application with the student (403 otherwise). Admins can view any student.",
          auth: "any",
          errors: [403, 404],
        }),
        params: studentIdParamSchema,
        response: { 200: studentPublicProfileSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as StudentIdParam;

      if (account.role === "STUDENT") {
        throw appError("Forbidden", 403, "Students cannot view other student profiles");
      }

      if (account.role === "TUTOR") {
        const tutor = await prisma.tutor.findUnique({ where: { accountId: account.accountId } });
        if (!tutor || !(await hasSharedApplication(tutor.id, id))) {
          throw appError("Forbidden", 403, "No shared application with this student");
        }
      }

      const profile = await getStudentById(id);
      if (!profile) throw notFound("Student not found");
      return reply.send(profile);
    },
  );

  app.get(
    "/:id/reviews",
    {
      schema: {
        ...routeDocs({
          tag: "Students",
          summary: "List reviews of a student",
          description:
            "Visible reviews that tutors left for the student, newest first. Any signed-in account can read them.",
          auth: "any",
        }),
        params: studentIdParamSchema,
        response: { 200: studentReviewListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireAuth(request);
      const { id } = request.params as StudentIdParam;
      const reviews = await getStudentReviews(id);
      return reply.send({
        reviews: reviews.map((r) => ({
          ...r,
          comment: r.comment ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  );
}
