import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

export async function requirementRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
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
    "/mine",
    {
      schema: {
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
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }

      return reply.send(requirement);
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
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
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }

      return reply.send(requirement);
    },
  );

  app.post(
    "/:id/close",
    {
      schema: {
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
        return reply.status(404).send({ error: "NotFound", message: "Requirement not found" });
      }

      return reply.send(requirement);
    },
  );
}
