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

export async function requirementRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "Create a requirement",
          description:
            "Creates an OPEN requirement, or a DRAFT when status is DRAFT (levelCode and curriculum may be null on drafts). 400 for an unknown area or subject, or for invalid education fields. 404 when the student has no profile.",
          auth: ["STUDENT"],
          errors: [400, 404],
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
            "Tutor browse (#46). OPEN requirements from ACTIVE students. scope=nearby matches requirements whose student pin is inside one of the tutor's zones, or whose area is in the tutor's service areas; scope=all skips the location match. Filters: curriculum, levelCode, subjectId, areaId. Newest first, keyset cursor. No matching score is applied yet. noServiceArea is true when the tutor has no zones and no areas.",
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
    "/mine",
    {
      schema: {
        ...routeDocs({
          tag: "Requirements",
          summary: "List my requirements",
          description: "Newest first. Empty when the student has no profile yet.",
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
          description: "Only the owning student can read it.",
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
            "Send any subset of fields. The merged values are checked against the education rules (400 INVALID_REQUIREMENT with details.fields). 409 when the requirement is not DRAFT or OPEN. Publishing (status OPEN) also needs every field set (400).",
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
