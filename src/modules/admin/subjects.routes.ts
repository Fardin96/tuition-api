import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  adminSubjectListSchema,
  adminSubjectSchema,
  type CreateSubjectInput,
  createSubjectSchema,
  type SubjectIdParam,
  subjectIdParamSchema,
  type UpdateSubjectInput,
  updateSubjectSchema,
} from "./subjects.schema.js";
import { createSubject, listAdminSubjects, updateSubject } from "./subjects.service.js";

export async function adminSubjectRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List subjects",
          description:
            "Every subject, inactive ones included, ordered by sortOrder then name. tutorCount counts the tutors who teach the subject.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminSubjectListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const subjects = await listAdminSubjects();
      return reply.send({ subjects });
    },
  );

  app.post(
    "/",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Create a subject",
          description:
            "The slug defaults to the lowercased name with non-alphanumerics replaced by dashes. 409 SUBJECT_EXISTS when the name (case-insensitive) or the slug is taken.",
          auth: "admin",
          errors: [409],
          rateLimit: "60/min per account",
        }),
        body: createSubjectSchema,
        response: { 201: adminSubjectSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const body = request.body as CreateSubjectInput;
      const created = await createSubject(body, admin, request.ip);
      return reply.code(201).send(created);
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Update a subject",
          description:
            "Renames, re-slugs, re-sorts or activates a subject. isActive false hides it from GET /subjects only; tutors keep it. 404 when the subject does not exist, 409 SUBJECT_EXISTS on a duplicate name or slug.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: subjectIdParamSchema,
        body: updateSubjectSchema,
        response: { 200: adminSubjectSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as SubjectIdParam;
      const body = request.body as UpdateSubjectInput;
      const updated = await updateSubject(id, body, admin, request.ip);
      return reply.send(updated);
    },
  );
}
