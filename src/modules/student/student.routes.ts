import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireRole } from "../../plugins/auth.js";
import {
  type StudentIdParam,
  type StudentProfileInput,
  studentIdParamSchema,
  studentProfileSchema,
  studentResponseSchema,
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
        body: updateStudentProfileSchema,
        response: { 200: studentResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const body = request.body as UpdateStudentProfileInput;
      const profile = await updateStudentProfile(account.accountId, body);
      if (!profile) {
        return reply.status(404).send({ error: "NotFound", message: "Student profile not found" });
      }
      return reply.send(profile);
    },
  );

  // Deferred: requires file upload / presigned URL flow.
  app.post("/me/verification", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: "NotImplemented",
      message: "File upload endpoint deferred until the storage module is implemented",
    });
  });

  app.get(
    "/:id",
    {
      schema: {
        params: studentIdParamSchema,
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            area: z.object({ id: z.number(), name: z.string() }),
            ratingAvg: z.number(),
            ratingCount: z.number(),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as StudentIdParam;

      if (account.role === "STUDENT") {
        return reply
          .status(403)
          .send({ error: "Forbidden", message: "Students cannot view other student profiles" });
      }

      if (account.role === "TUTOR") {
        const tutor = await prisma.tutor.findUnique({ where: { accountId: account.accountId } });
        if (!tutor || !(await hasSharedApplication(tutor.id, id))) {
          return reply
            .status(403)
            .send({ error: "Forbidden", message: "No shared application with this student" });
        }
      }

      const profile = await getStudentById(id);
      if (!profile) {
        return reply.status(404).send({ error: "NotFound", message: "Student not found" });
      }
      return reply.send(profile);
    },
  );

  app.get(
    "/:id/reviews",
    {
      schema: {
        params: studentIdParamSchema,
        response: {
          200: z.object({
            reviews: z.array(
              z.object({
                id: z.string(),
                rating: z.number(),
                comment: z.string().nullable(),
                createdAt: z.string(),
                tutor: z.object({ id: z.string(), name: z.string() }),
              }),
            ),
          }),
        },
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
