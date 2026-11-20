import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "../../lib/errors.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import { privateCache, publicCache } from "../../plugins/cache.js";
import { findNearbyTutors } from "../location/location.service.js";
import { type ReviewPageQuery, reviewPageQuerySchema } from "../review/review.schema.js";
import {
  type SubmitVerificationInput,
  submitVerificationSchema,
} from "../student/student.schema.js";
import {
  type CreateCredentialInput,
  type CreateTutorRequirementInput,
  type CreateVideoInput,
  createCredentialSchema,
  createTutorRequirementSchema,
  createVideoSchema,
  type TutorAreasInput,
  type TutorIdParam,
  type TutorNearbyQuery,
  type TutorProfileInput,
  type TutorRequirementListQuery,
  type TutorSearchQuery,
  type TutorSubjectsInput,
  tutorAreasResponseSchema,
  tutorAreasSchema,
  tutorCredentialListResponseSchema,
  tutorCredentialResponseSchema,
  tutorIdParamSchema,
  tutorNearbyListResponseSchema,
  tutorNearbyQuerySchema,
  tutorProfileSchema,
  tutorPublicProfileResponseSchema,
  tutorPublicVideoListResponseSchema,
  tutorRequirementIdParamSchema,
  tutorRequirementListQuerySchema,
  tutorRequirementListResponseSchema,
  tutorRequirementResponseSchema,
  tutorResponseSchema,
  tutorReviewListResponseSchema,
  tutorSearchListResponseSchema,
  tutorSearchQuerySchema,
  tutorSubjectsResponseSchema,
  tutorSubjectsSchema,
  tutorVerificationListResponseSchema,
  tutorVerificationResponseSchema,
  tutorVideoListResponseSchema,
  tutorVideoResponseSchema,
  type UpdateTutorProfileInput,
  type UpdateTutorRequirementInput,
  updateTutorProfileSchema,
  updateTutorRequirementSchema,
} from "./tutor.schema.js";
import {
  addNearbyCardFields,
  addTutorCredential,
  addTutorVideo,
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
  submitTutorVerification,
  updateTutorProfile,
  updateTutorRequirement,
} from "./tutor.service.js";

export async function tutorRoutes(app: FastifyInstance) {
  app.post(
    "/me",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Create my tutor profile",
          description:
            "Creates the tutor profile for the signed-in account. Fails with 409 PROFILE_EXISTS when a profile already exists, and with 409 PHONE_IN_USE or 409 WHATSAPP_IN_USE when a number belongs to another account.",
          auth: ["TUTOR"],
          errors: [409],
        }),
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
        ...routeDocs({
          tag: "Tutors",
          summary: "Update my tutor profile",
          description:
            "Send at least one field. Fails with 409 PHONE_IN_USE or 409 WHATSAPP_IN_USE when a number belongs to another account. A changed WhatsApp number clears whatsappVerifiedAt.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        body: updateTutorProfileSchema,
        response: { 200: tutorResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as UpdateTutorProfileInput;
      const profile = await updateTutorProfile(account.accountId, body);
      if (!profile) {
        throw notFound("Tutor profile not found");
      }
      return reply.send(profile);
    },
  );

  app.put(
    "/me/areas",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Replace my areas",
          description:
            "Replaces the tutor's areas with areaIds. Every area must be in the tutor's city, the district of the saved address. An area that is unknown, inactive or out-of-city gets 409 AREA_OUTSIDE_CITY with details.invalidAreaIds and nothing is written. An inactive area the tutor already has may stay in the set.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        body: tutorAreasSchema,
        response: { 200: tutorAreasResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { areaIds } = request.body as TutorAreasInput;
      const areas = await replaceTutorAreas(account.accountId, areaIds);
      if (!areas) {
        throw notFound("Tutor profile not found");
      }
      return reply.send({ areas });
    },
  );

  app.put(
    "/me/subjects",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Replace my subjects",
          description:
            "Replaces the tutor's subjects with subjectIds. Fails with 409 REQUIREMENT_LOSES_LAST_SUBJECT (details.requirementIds, details.packageIds) when an active requirement set or an OPEN package would be left with no subjects. Archived sets, closed packages and OPEN packages that keep another subject lose the removed subject silently.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        body: tutorSubjectsSchema,
        response: { 200: tutorSubjectsResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { subjectIds } = request.body as TutorSubjectsInput;
      const subjects = await replaceTutorSubjects(account.accountId, subjectIds);
      if (!subjects) throw notFound("Tutor profile not found");
      return reply.send({ subjects });
    },
  );

  app.post(
    "/me/verifications",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Submit a verification",
          description:
            "Sends an uploaded student ID file for review. Your profile needs a student ID number first (400). Refused while a submission is under review or once you are verified (409). The file must be yours, purpose TUTOR_ID and finished uploading. Returns the new submission.",
          auth: ["TUTOR"],
          errors: [404, 409],
          rateLimit: "10/min per account",
        }),
        body: submitVerificationSchema,
        response: { 201: tutorVerificationResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { fileId } = request.body as SubmitVerificationInput;
      const verification = await submitTutorVerification(account.accountId, fileId);
      if (!verification) throw notFound("Tutor profile not found");
      return reply.status(201).send({
        ...verification,
        submittedAt: verification.submittedAt.toISOString(),
        decidedAt: verification.decidedAt?.toISOString() ?? null,
      });
    },
  );

  app.get(
    "/me/verifications",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "List my verification submissions",
          description:
            "Submission history, newest first. Only one submission is PENDING at a time.",
          auth: ["TUTOR"],
          errors: [404],
        }),
        response: { 200: tutorVerificationListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const verifications = await getTutorVerifications(account.accountId);
      if (!verifications) {
        throw notFound("Tutor profile not found");
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
        ...routeDocs({
          tag: "Tutors",
          summary: "Find tutors near me",
          description:
            "Tutors in the student's district within radiusMeters of the student's pin, nearest first. Tutors whose location needs readdressing are left out. Returns an empty list when the student has no saved location.",
          auth: ["STUDENT"],
        }),
        querystring: tutorNearbyQuerySchema,
        response: { 200: tutorNearbyListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const query = request.query as TutorNearbyQuery;
      const tutors = await findNearbyTutors(account.accountId, query.radiusMeters);
      return reply.send({ tutors: await addNearbyCardFields(tutors) });
    },
  );

  app.get(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Search tutors",
          description:
            "Listed tutors only (isListed), highest rating first. Filters: area, subject, gender, rating (minimum), name (contains, case-insensitive).",
          auth: "optional",
        }),
        querystring: tutorSearchQuerySchema,
        response: { 200: tutorSearchListResponseSchema },
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
          instituteName: t.instituteName,
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
        ...routeDocs({
          tag: "Tutors",
          summary: "Get a tutor's public profile",
          description:
            "Name, gender, rating, areas, subjects, credentials and approved videos. Contact details and address are never included. An unlisted tutor (isListed false) answers 200 only to that tutor, to an ACTIVE admin, and to a student with an application with this tutor; anyone else gets the same 404 as an unknown id. Unlisted responses, 404s included, send Cache-Control: private, no-store.",
          auth: "optional",
          errors: [404],
        }),
        params: tutorIdParamSchema,
        response: { 200: tutorPublicProfileResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as TutorIdParam;
      const found = await getPublicTutorProfile(id, request.account);
      // Only a listed profile may sit in a shared cache. Unlisted, hidden and unknown ids all get
      // private, no-store, so the headers never reveal whether an unlisted tutor exists.
      if (found?.isListed) {
        publicCache(request, reply, "public, max-age=60, stale-while-revalidate=300");
      } else {
        privateCache(reply);
      }
      if (!found) {
        throw notFound("Tutor not found");
      }
      return reply.send({ tutor: found.profile });
    },
  );

  app.get(
    "/:id/reviews",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "List a tutor's reviews",
          description:
            "Visible reviews written by students, newest first, cursor-paginated (limit 1 to 100, default 25). summary has the average, the count and the 1 to 5 star breakdown. 404 when the tutor does not exist.",
          auth: "optional",
          errors: [404],
        }),
        params: tutorIdParamSchema,
        querystring: reviewPageQuerySchema,
        response: { 200: tutorReviewListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      const { id } = request.params as TutorIdParam;
      const page = await getTutorReviews(id, request.query as ReviewPageQuery);
      if (!page) throw notFound("Tutor not found");
      return reply.send({
        reviews: page.reviews.map((r) => ({
          ...r,
          comment: r.comment ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
        summary: page.summary,
      });
    },
  );

  app.get(
    "/me/credentials",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "List my credentials",
          description: "Credentials ordered by exam label.",
          auth: ["TUTOR"],
          errors: [404],
        }),
        response: { 200: tutorCredentialListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const credentials = await getTutorCredentials(account.accountId);
      if (!credentials) {
        throw notFound("Tutor profile not found");
      }
      return reply.send({ credentials });
    },
  );

  app.post(
    "/me/credentials",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Add a credential",
          description:
            "Adds a certificate file with its exam label and result. The file must be yours, purpose CREDENTIAL and finished uploading. A tutor can keep at most 20 credentials (409 UPLOAD_LIMIT_REACHED).",
          auth: ["TUTOR"],
          errors: [404, 409],
          rateLimit: "30/min per account",
        }),
        body: createCredentialSchema,
        response: { 201: tutorCredentialResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateCredentialInput;
      const credential = await addTutorCredential(account.accountId, body);
      if (!credential) throw notFound("Tutor profile not found");
      return reply.status(201).send(credential);
    },
  );

  app.delete(
    "/me/credentials/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Remove a credential",
          description: "Removes one of your credentials and its file. Replies 204 with no body.",
          auth: ["TUTOR"],
          errors: [404],
          noContent: true,
        }),
        params: tutorIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as TutorIdParam;
      const deleted = await deleteTutorCredential(account.accountId, id);
      if (!deleted) {
        throw notFound("Credential not found");
      }
      return reply.status(204).send();
    },
  );

  app.get(
    "/me/videos",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "List my videos",
          description: "Your own videos in any moderation state, in display order.",
          auth: ["TUTOR"],
          errors: [404],
        }),
        response: { 200: tutorVideoListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const videos = await getTutorVideos(account.accountId);
      if (!videos) {
        throw notFound("Tutor profile not found");
      }
      return reply.send({ videos });
    },
  );

  app.post(
    "/me/videos",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Add a video",
          description:
            "Adds an uploaded video as PENDING. It appears publicly only after an admin approves it. The file must be yours, purpose TUTOR_VIDEO and finished uploading. A tutor can keep at most 3 videos (409 UPLOAD_LIMIT_REACHED).",
          auth: ["TUTOR"],
          errors: [404, 409],
          rateLimit: "10/min per account",
        }),
        body: createVideoSchema,
        response: { 201: tutorVideoResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateVideoInput;
      const video = await addTutorVideo(account.accountId, body);
      if (!video) throw notFound("Tutor profile not found");
      return reply.status(201).send(video);
    },
  );

  app.delete(
    "/me/videos/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Tutors",
          summary: "Remove a video",
          description:
            "Removes one of your videos and its file, public copy included. Replies 204 with no body.",
          auth: ["TUTOR"],
          errors: [404],
          noContent: true,
        }),
        params: tutorIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as TutorIdParam;
      const deleted = await deleteTutorVideo(account.accountId, id);
      if (!deleted) {
        throw notFound("Video not found");
      }
      return reply.status(204).send();
    },
  );

  app.get(
    "/me/requirements",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "List my requirement sets",
          description:
            "status=active (default) lists active sets, archived lists archived sets (newest first, capped at 50), all lists both.",
          auth: ["TUTOR"],
          errors: [404],
        }),
        querystring: tutorRequirementListQuerySchema,
        response: { 200: tutorRequirementListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { status } = request.query as TutorRequirementListQuery;
      const requirements = await listTutorRequirements(account.accountId, status);
      if (!requirements) {
        throw notFound("Tutor profile not found");
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send({ requirements });
    },
  );

  app.post(
    "/me/requirements",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Create a requirement set",
          description:
            "The first set becomes the default. syncProfileSubjects adds missing subjects to the profile in the same transaction. Fails with 409 REQUIREMENT_LIMIT_REACHED at 10 active sets, 400 INVALID_SUBJECT_OR_ZONE when a zone is not on the profile or a subject fails the foreign key check, and 400 VALIDATION_ERROR for an unknown subject. A set needs a zone or teachesOnline (400 VALIDATION_ERROR on zoneIds).",
          auth: ["TUTOR"],
          errors: [400, 404, 409],
        }),
        body: createTutorRequirementSchema,
        response: { 201: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const body = request.body as CreateTutorRequirementInput;
      const requirement = await createTutorRequirement(account.accountId, body);
      if (!requirement) {
        throw notFound("Tutor profile not found");
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(requirement);
    },
  );

  app.get(
    "/me/requirements/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Get a requirement set",
          description: "Returns the set whether it is active or archived.",
          auth: ["TUTOR"],
          errors: [404],
        }),
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await getTutorRequirement(account.accountId, id);
      if (!requirement) {
        throw notFound("Requirement not found");
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.patch(
    "/me/requirements/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Update a requirement set",
          description:
            "Send at least one field. Allowed on archived sets. Values are checked against the stored set: 400 INVALID_REQUIREMENT (details.fields) for an invalid combination, 400 VALIDATION_ERROR for an unknown subject, 400 INVALID_SUBJECT_OR_ZONE when a zone is not on the profile. Subjects and zones are diff-applied. The merged set still needs a zone or teachesOnline: 400 INVALID_REQUIREMENT with fields zoneIds otherwise.",
          auth: ["TUTOR"],
          errors: [400, 404],
        }),
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
        throw notFound("Requirement not found");
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.post(
    "/me/requirements/:id/default",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Make a requirement set the default",
          description:
            "Unsets the previous default. Fails with 409 REQUIREMENT_ARCHIVED for an archived set.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await setDefaultTutorRequirement(account.accountId, id);
      if (!requirement) {
        throw notFound("Requirement not found");
      }
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.delete(
    "/me/requirements/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Archive a requirement set",
          description:
            "Sets isActive to false. Fails with 409 REQUIREMENT_IS_DEFAULT for the default set. Packages are offers and do not reference a set, so archiving never waits on them. An archived set is returned unchanged.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await archiveTutorRequirement(account.accountId, id);
      if (!requirement) throw notFound("Requirement not found");
      reply.header("Cache-Control", "private, no-store");
      return reply.send(requirement);
    },
  );

  app.post(
    "/me/requirements/:id/restore",
    {
      schema: {
        ...routeDocs({
          tag: "Tutor requirements",
          summary: "Restore an archived requirement set",
          description:
            "Sets isActive to true. A restored set never becomes the default. Fails with 409 REQUIREMENT_LIMIT_REACHED at 10 active sets, and with 409 REQUIREMENT_NO_SUBJECTS when the set has no subjects. An active set is returned unchanged.",
          auth: ["TUTOR"],
          errors: [404, 409],
        }),
        params: tutorRequirementIdParamSchema,
        response: { 200: tutorRequirementResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as { id: string };
      const requirement = await restoreTutorRequirement(account.accountId, id);
      if (!requirement) {
        throw notFound("Requirement not found");
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
        ...routeDocs({
          tag: "Videos",
          summary: "List approved videos",
          description: "Approved videos from all tutors, in display order.",
          auth: "optional",
        }),
        response: { 200: tutorPublicVideoListResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      const videos = await getApprovedVideos();
      return reply.send({ videos });
    },
  );
}
