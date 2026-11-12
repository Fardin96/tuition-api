import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../plugins/auth.js";
import { publicCache } from "../../plugins/cache.js";
import { findNearbyTutors } from "../location/location.service.js";
import {
  type CreateTutorRequirementInput,
  createTutorRequirementSchema,
  type TutorAreasInput,
  type TutorIdParam,
  type TutorNearbyQuery,
  type TutorProfileInput,
  type TutorSearchQuery,
  type TutorSubjectsInput,
  tutorAreasSchema,
  tutorIdParamSchema,
  tutorNearbyQuerySchema,
  tutorProfileSchema,
  tutorRequirementIdParamSchema,
  tutorRequirementListResponseSchema,
  tutorRequirementResponseSchema,
  tutorResponseSchema,
  tutorSearchQuerySchema,
  tutorSubjectsSchema,
  type UpdateTutorProfileInput,
  type UpdateTutorRequirementInput,
  updateTutorProfileSchema,
  updateTutorRequirementSchema,
} from "./tutor.schema.js";
import {
  archiveTutorRequirement,
  createTutorProfile,
  createTutorRequirement,
  deleteTutorCredential,
  deleteTutorVideo,
  getApprovedVideos,
  getPublicTutorProfile,
  getTutorCredentials,
  getTutorRequirement,
  getTutorReviews,
  getTutorVerifications,
  getTutorVideos,
  listTutorRequirements,
  replaceTutorAreas,
  replaceTutorSubjects,
  restoreTutorRequirement,
  searchTutors,
  setDefaultTutorRequirement,
  updateTutorProfile,
  updateTutorRequirement,
} from "./tutor.service.js";

export async function tutorRoutes(app: FastifyInstance) {
  app.post(
    "/me",
    {
      schema: {
        body: tutorProfileSchema,
        response: { 201: tutorResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as TutorProfileInput;
      const profile = await createTutorProfile(account.accountId, body);
      return reply.status(201).send(profile);
    },
  );

  app.patch(
    "/me",
    {
      schema: {
        body: updateTutorProfileSchema,
        response: { 200: tutorResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as UpdateTutorProfileInput;
      const profile = await updateTutorProfile(account.accountId, body);
      if (!profile) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send(profile);
    },
  );

  app.put(
    "/me/areas",
    {
      schema: {
        body: tutorAreasSchema,
        response: {
          200: z.object({
            areas: z.array(z.object({ area: z.object({ id: z.number(), name: z.string() }) })),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { areaIds } = request.body as TutorAreasInput;
      const areas = await replaceTutorAreas(account.accountId, areaIds);
      if (!areas) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send({ areas });
    },
  );

  app.put(
    "/me/subjects",
    {
      schema: {
        body: tutorSubjectsSchema,
        response: {
          200: z.object({
            subjects: z.array(
              z.object({ subject: z.object({ id: z.number(), name: z.string() }) }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { subjectIds } = request.body as TutorSubjectsInput;
      let subjects: Awaited<ReturnType<typeof replaceTutorSubjects>>;
      try {
        subjects = await replaceTutorSubjects(account.accountId, subjectIds);
      } catch (err) {
        const e = err as Error & { code?: string; requirementIds?: string[] };
        if (e.code !== "REQUIREMENT_LOSES_LAST_SUBJECT") throw err;
        return reply
          .status(409)
          .send({ error: e.name, message: e.message, requirementIds: e.requirementIds });
      }
      if (!subjects) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send({ subjects });
    },
  );

  // Deferred: requires file upload / presigned URL flow.
  app.post("/me/verifications", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: "NotImplemented",
      message: "File upload endpoint deferred until the storage module is implemented",
    });
  });

  app.get(
    "/me/verifications",
    {
      schema: {
        response: {
          200: z.object({
            verifications: z.array(
              z.object({
                id: z.string(),
                status: z.string(),
                submittedAt: z.string(),
                decidedAt: z.string().nullable(),
                note: z.string().nullable(),
                file: z.object({ id: z.string(), status: z.string() }),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const verifications = await getTutorVerifications(account.accountId);
      if (!verifications) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send({
        verifications: verifications.map((v) => ({
          ...v,
          submittedAt: v.submittedAt.toISOString(),
          decidedAt: v.decidedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.get(
    "/nearby",
    {
      schema: {
        querystring: tutorNearbyQuerySchema,
        response: {
          200: z.object({
            tutors: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                gender: z.string(),
                ratingAvg: z.number(),
                ratingCount: z.number(),
                distanceMeters: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const query = request.query as TutorNearbyQuery;
      const tutors = await findNearbyTutors(account.accountId, query.radiusMeters);
      return reply.send({ tutors });
    },
  );

  app.get(
    "/",
    {
      schema: {
        querystring: tutorSearchQuerySchema,
        response: {
          200: z.object({
            tutors: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                gender: z.string(),
                ratingAvg: z.number(),
                ratingCount: z.number(),
                areas: z.array(z.object({ id: z.number(), name: z.string() })),
                subjects: z.array(z.object({ id: z.number(), name: z.string() })),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=60, stale-while-revalidate=300");
      const query = request.query as TutorSearchQuery;
      const tutors = await searchTutors({
        area: query.area,
        subject: query.subject,
        gender: query.gender,
        rating: query.rating,
        name: query.name,
      });
      return reply.send({
        tutors: tutors.map((t) => ({
          id: t.id,
          name: t.name,
          gender: t.gender,
          ratingAvg: Number(t.ratingAvg),
          ratingCount: t.ratingCount,
          areas: t.areas.map((a) => a.area),
          subjects: t.subjects.map((s) => s.subject),
        })),
      });
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        params: tutorIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=60, stale-while-revalidate=300");
      const { id } = request.params as TutorIdParam;
      const tutor = await getPublicTutorProfile(id);
      if (!tutor) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor not found" });
      }
      return reply.send({ tutor });
    },
  );

  app.get(
    "/:id/reviews",
    {
      schema: {
        params: tutorIdParamSchema,
        response: {
          200: z.object({
            reviews: z.array(
              z.object({
                id: z.string(),
                rating: z.number(),
                comment: z.string().nullable(),
                createdAt: z.string(),
                student: z.object({ id: z.string(), name: z.string() }),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      const { id } = request.params as TutorIdParam;
      const reviews = await getTutorReviews(id);
      return reply.send({
        reviews: reviews.map((r) => ({
          ...r,
          comment: r.comment ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    "/me/credentials",
    {
      schema: {
        response: {
          200: z.object({
            credentials: z.array(
              z.object({
                id: z.string(),
                examLabel: z.string(),
                result: z.string(),
                file: z.object({ id: z.string(), status: z.string() }),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const credentials = await getTutorCredentials(account.accountId);
      if (!credentials) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send({ credentials });
    },
  );

  // Deferred: requires file upload / presigned URL flow.
  app.post("/me/credentials", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: "NotImplemented",
      message: "File upload endpoint deferred until the storage module is implemented",
    });
  });

  app.delete(
    "/me/credentials/:id",
    {
      schema: { params: tutorIdParamSchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as TutorIdParam;
      const deleted = await deleteTutorCredential(account.accountId, id);
      if (!deleted) {
        return reply.status(404).send({ error: "NotFound", message: "Credential not found" });
      }
      return reply.status(204).send();
    },
  );

  app.get(
    "/me/videos",
    {
      schema: {
        response: {
          200: z.object({
            videos: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                status: z.string(),
                sortOrder: z.number(),
                createdAt: z.string(),
                file: z.object({ id: z.string(), status: z.string() }),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const videos = await getTutorVideos(account.accountId);
      if (!videos) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      return reply.send({
        videos: videos.map((v) => ({
          ...v,
          createdAt: v.createdAt.toISOString(),
        })),
      });
    },
  );

  // Deferred: requires file upload / presigned URL flow.
  app.post("/me/videos", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: "NotImplemented",
      message: "File upload endpoint deferred until the storage module is implemented",
    });
  });

  app.delete(
    "/me/videos/:id",
    {
      schema: { params: tutorIdParamSchema },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as TutorIdParam;
      const deleted = await deleteTutorVideo(account.accountId, id);
      if (!deleted) {
        return reply.status(404).send({ error: "NotFound", message: "Video not found" });
      }
      return reply.status(204).send();
    },
  );

  app.get(
    "/me/requirements",
    {
      schema: {
        response: { 200: tutorRequirementListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const requirements = await listTutorRequirements(account.accountId);
      if (!requirements) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send({ requirements });
    },
  );

  app.post(
    "/me/requirements",
    {
      schema: {
        body: createTutorRequirementSchema,
        response: { 201: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateTutorRequirementInput;
      const requirement = await createTutorRequirement(account.accountId, body);
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Tutor profile not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(requirement);
    },
  );

  app.get(
    "/me/requirements/:id",
    {
      schema: {
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await getTutorRequirement(account.accountId, id);
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.patch(
    "/me/requirements/:id",
    {
      schema: {
        params: tutorRequirementIdParamSchema,
        body: updateTutorRequirementSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const body = request.body as UpdateTutorRequirementInput;
      const requirement = await updateTutorRequirement(account.accountId, id, body);
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.post(
    "/me/requirements/:id/default",
    {
      schema: {
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await setDefaultTutorRequirement(account.accountId, id);
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.delete(
    "/me/requirements/:id",
    {
      schema: {
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      let requirement: Awaited<ReturnType<typeof archiveTutorRequirement>>;
      try {
        requirement = await archiveTutorRequirement(account.accountId, id);
      } catch (err) {
        const e = err as Error & { code?: string; packageIds?: string[] };
        if (e.code !== "REQUIREMENT_IN_USE") throw err;
        return reply
          .status(409)
          .send({ error: e.name, message: e.message, packageIds: e.packageIds });
      }
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.post(
    "/me/requirements/:id/restore",
    {
      schema: {
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await restoreTutorRequirement(account.accountId, id);
      if (!requirement) {
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );
}

export async function publicVideoRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        response: {
          200: z.object({
            videos: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                sortOrder: z.number(),
                createdAt: z.string(),
                tutor: z.object({ id: z.string(), name: z.string() }),
                file: z.object({ id: z.string(), status: z.string() }),
              }),
            ),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      const videos = await getApprovedVideos();
      return reply.send({
        videos: videos.map((v) => ({
          ...v,
          createdAt: v.createdAt.toISOString(),
        })),
      });
    },
  );
}
