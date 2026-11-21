import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "../../lib/errors.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateRequirementInput,
  createRequirementSchema,
  type RequirementIdParam,
  requirementIdParamSchema,
  requirementListResponseSchema,
  requirementResponseSchema,
  type UpdateRequirementInput,
  updateRequirementSchema,
} from "./requirement.schema.js";
import {
  closeRequirement,
  createRequirement,
  getRequirementById,
  getRequirementsForStudent,
  updateRequirement,
} from "./requirement.service.js";
import {
  browseRequirementPageSchema,
  type RequirementBrowseQuery,
  requirementBrowseQuerySchema,
} from "./requirement-browse.schema.js";
import { browseRequirements } from "./requirement-browse.service.js";
import {
  type RecommendedTutorsQuery,
  type RequirementInviteBody,
  recommendedTutorPageSchema,
  recommendedTutorsQuerySchema,
  requirementInviteBodySchema,
  requirementInviteSchema,
} from "./requirement-match.schema.js";
import { inviteTutor, listRecommendedTutors } from "./requirement-match.service.js";

export async function requirementRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Create a requirement",
          description:
            "Creates an OPEN requirement, or a DRAFT when status is DRAFT (levelCode and curriculum may be null on drafts). 400 for an unknown area or subject, or for invalid education fields. 404 when the student has no profile. 409 REQUIREMENT_DUPLICATE (details.requirementId) when posting OPEN and the student already has an OPEN requirement with no hired tutor for the same level, curriculum, academic group, admission targets, area and subjects; drafts are never checked.",
          auth: ["STUDENT"],
          errors: [400, 404, 409],
        }),
        body: createRequirementSchema,
        response: {
          201: requirementResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const body = request.body as CreateRequirementInput;
      const requirement = await createRequirement(account.accountId, body);
      return reply.status(201).send(requirement);
    },
  );

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Browse open requirements",
          description:
            "Tutor browse (#46). OPEN requirements from ACTIVE students. scope=nearby matches requirements whose student pin is inside one of the tutor's zones, or whose area is in the tutor's service areas; scope=all skips the location match. scope=set lists the requirements that the matching engine pairs with one of the tutor's own active sets (setId, required); each row carries match {score, reasons}, and matchVersion is the config version. sort=newest (default) keeps newest first with a keyset cursor; sort=match (scope=set only) ranks by score, best first, then newest, capped at 300 with an offset cursor. scope=invited lists the OPEN requirements the tutor was invited to, newest invite first. The manual filters (curriculum, levelCode, subjectId, areaId) apply to nearby and all only. Every row has invitedAt. gaps explains an empty set page. noServiceArea is true when the tutor has no zones and no areas.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        querystring: requirementBrowseQuerySchema,
        response: {
          200: browseRequirementPageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const query = request.query as RequirementBrowseQuery;
      const page = await browseRequirements(account.accountId, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  app.get(
    "/:id/tutors",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Tutors who match my requirement",
          description:
            "Listed tutors whose best active set matches the requirement, best match first, 20 per page (page 1 to 15, at most 300 tutors). Each tutor has match reasons for the student and no numeric score. invitedAt is set when this student invited the tutor; application is the tutor's application here, any status. suggestions appear when fewer than 3 tutors match: allowing online tuition or any tutor gender would add tutors. 404 when the requirement is not the caller's; 409 LISTING_NOT_OPEN when it is not OPEN.",
          auth: ["STUDENT"],
          errors: [404, 409],
          rateLimit: "120/min per account",
        }),
        params: requirementIdParamSchema,
        querystring: recommendedTutorsQuerySchema,
        response: {
          200: recommendedTutorPageSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as RequirementIdParam;
      const { page } = request.query as RecommendedTutorsQuery;
      const result = await listRecommendedTutors(account.accountId, id, page);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );

  app.post(
    "/:id/invites",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Invite a tutor to my requirement",
          description:
            "Invites a listed tutor to an OPEN requirement. The tutor gets a REQUIREMENT_INVITED alert. No match is needed. 404 when the requirement is not the caller's or the tutor is not listed; 409 LISTING_NOT_OPEN, APPLICATION_CLOSED, ALREADY_APPLIED (the tutor has an application here), INVITE_EXISTS, or INVITE_LIMIT_REACHED (20 invites per requirement).",
          auth: ["STUDENT"],
          errors: [404, 409],
          rateLimit: "30/min per account",
        }),
        params: requirementIdParamSchema,
        body: requirementInviteBodySchema,
        response: {
          201: requirementInviteSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as RequirementIdParam;
      const { tutorId } = request.body as RequirementInviteBody;
      const invite = await inviteTutor(account.accountId, id, tutorId);
      return reply.status(201).send(invite);
    },
  );

  app.get(
    "/mine",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "List my requirements",
          description:
            "Newest first. Empty when the student has no profile yet. status reads FILLED while the requirement has a CONFIRMED or COMPLETED application, whatever the stored status.",
          auth: ["STUDENT"],
        }),
        response: {
          200: requirementListResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const requirements = await getRequirementsForStudent(account.accountId);
      return reply.send({ requirements });
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Get one of my requirements",
          description:
            "Only the owning student can read it. status reads FILLED while it has a CONFIRMED or COMPLETED application.",
          auth: ["STUDENT"],
          errors: [404],
        }),
        params: requirementIdParamSchema,
        response: {
          200: requirementResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as RequirementIdParam;

      const requirement = await getRequirementById(id, account.accountId);
      if (!requirement) {
        throw notFound("Requirement not found");
      }

      return reply.send(requirement);
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Update my requirement",
          description:
            "Send any subset of fields. The merged values are checked against the education rules (400 INVALID_REQUIREMENT with details.fields). 409 when the requirement is not DRAFT or OPEN, or has a hired tutor (a CONFIRMED or COMPLETED application). 409 REQUIREMENT_DUPLICATE (details.requirementId) when the result is OPEN and matches another of the student's OPEN, unhired requirements. Publishing (status OPEN) also needs every field set (400).",
          auth: ["STUDENT"],
          errors: [400, 404, 409],
        }),
        params: requirementIdParamSchema,
        body: updateRequirementSchema,
        response: {
          200: requirementResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as RequirementIdParam;
      const body = request.body as UpdateRequirementInput;

      const requirement = await updateRequirement(id, account.accountId, body);
      if (!requirement) {
        throw notFound("Requirement not found");
      }

      return reply.send(requirement);
    },
  );

  app.post(
    "/:id/close",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Close my requirement",
          description: "Moves a DRAFT or OPEN requirement to CLOSED. 409 for any other status.",
          auth: ["STUDENT"],
          errors: [404, 409],
        }),
        params: requirementIdParamSchema,
        response: {
          200: requirementResponseSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as RequirementIdParam;

      const requirement = await closeRequirement(id, account.accountId);
      if (!requirement) {
        throw notFound("Requirement not found");
      }

      return reply.send(requirement);
    },
  );
}
