import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { type DocErrorStatus, routeDocs } from "../../openapi/docs.js";
import { requireAuth, requireRole } from "../../plugins/auth.js";
import {
  getApplicationForCaller,
  listMyApplications,
  listPackageApplications,
  listRequirementApplications,
} from "./application.read.service.js";
import {
  type ApplicationAction,
  type ApplicationIdParam,
  type ApplicationListQuery,
  applicationDetailSchema,
  applicationIdParamSchema,
  applicationListQuerySchema,
  applicationPageSchema,
} from "./application.schema.js";
import {
  applyToRequirement,
  requestPackage,
  transitionApplication,
} from "./application.write.service.js";

const TRANSITIONS: {
  action: ApplicationAction;
  summary: string;
  description: string;
  errors: DocErrorStatus[];
}[] = [
  {
    action: "confirm",
    summary: "Confirm an application",
    description:
      "#63. The counterparty accepts. Other pending applications on the same listing are rejected, and a placement fee is created at commission_percent (40% unless an admin sets another rate; an explicit 0 creates none).",
    errors: [404, 409],
  },
  {
    action: "reject",
    summary: "Reject an application",
    description: "#64. The counterparty declines a pending application.",
    errors: [404, 409],
  },
  {
    action: "withdraw",
    summary: "Withdraw an application",
    description: "#65. The initiator withdraws a pending application.",
    errors: [404, 409],
  },
  {
    action: "reopen",
    summary: "Reopen an application",
    description:
      "#66. The initiator sends a withdrawn, rejected or expired application again. The listing must still be open and not closed. A tutor reopening re-checks profile completeness (403 PROFILE_INCOMPLETE).",
    errors: [403, 404, 409],
  },
  {
    action: "cancel",
    summary: "Cancel a placement",
    description:
      "#67. Either party ends a confirmed placement. The unpaid placement fee is voided.",
    errors: [404, 409],
  },
  {
    action: "complete",
    summary: "Complete a placement",
    description: "#68. Either party marks a confirmed placement as finished.",
    errors: [404, 409],
  },
];

export async function applicationRoutes(app: FastifyInstance) {
  app.post(
    "/requirements/:id/applications",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "Apply to a requirement",
          description:
            "#57. A tutor applies to an open requirement. Fails with 403 PROFILE_INCOMPLETE until the profile passes the apply gate, 409 ALREADY_APPLIED for a repeat, and 409 APPLICATION_CLOSED once the tuition has a confirmed application.",
          auth: ["TUTOR"],
          errors: [403, 404, 409],
          rateLimit: "60/min per account",
        }),
        params: applicationIdParamSchema,
        response: { 201: applicationDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as ApplicationIdParam;
      const newId = await applyToRequirement(account, id);
      const detail = await getApplicationForCaller(newId, account);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(detail);
    },
  );

  app.post(
    "/packages/:id/applications",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "Request a package",
          description:
            "#58. A student asks to take an approved, open package from a listed tutor. Fails with 409 ALREADY_APPLIED for a repeat and 409 APPLICATION_CLOSED once the package has a confirmed application.",
          auth: ["STUDENT"],
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: applicationIdParamSchema,
        response: { 201: applicationDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as ApplicationIdParam;
      const newId = await requestPackage(account, id);
      const detail = await getApplicationForCaller(newId, account);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(detail);
    },
  );

  app.get(
    "/applications",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "List my applications",
          description: "Newest first, cursor-paginated. Filter by status.",
          auth: ["TUTOR", "STUDENT"],
          rateLimit: "300/min per account",
        }),
        querystring: applicationListQuerySchema,
        response: { 200: applicationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR", "STUDENT");
      const query = request.query as ApplicationListQuery;
      const page = await listMyApplications(account, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  app.get(
    "/applications/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "Get an application",
          description:
            "Visible to the tutor and student on the application, and to active admins. Admins get no allowedActions. Contact numbers appear only once CONFIRMED or COMPLETED, and the fee only for the tutor and admins.",
          auth: "any",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: applicationIdParamSchema,
        response: { 200: applicationDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as ApplicationIdParam;
      const detail = await getApplicationForCaller(id, account);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(detail);
    },
  );

  app.get(
    "/requirements/:id/applications",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "List applications to my requirement",
          description:
            "Applications from tutors to one of the student's requirements. Newest first.",
          auth: ["STUDENT"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: applicationIdParamSchema,
        querystring: applicationListQuerySchema,
        response: { 200: applicationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT");
      const { id } = request.params as ApplicationIdParam;
      const query = request.query as ApplicationListQuery;
      const page = await listRequirementApplications(id, account, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  app.get(
    "/packages/:id/applications",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Applications",
          summary: "List requests for my package",
          description: "Student requests for one of the tutor's packages. Newest first.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: applicationIdParamSchema,
        querystring: applicationListQuerySchema,
        response: { 200: applicationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as ApplicationIdParam;
      const query = request.query as ApplicationListQuery;
      const page = await listPackageApplications(id, account, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  for (const transition of TRANSITIONS) {
    const { action } = transition;
    app.post(
      `/applications/:id/${action}`,
      {
        config: accountRateLimit(60, "1 minute"),
        schema: {
          ...routeDocs({
            tag: "Applications",
            summary: transition.summary,
            description: transition.description,
            auth: ["TUTOR", "STUDENT"],
            errors: transition.errors,
            rateLimit: "60/min per account",
          }),
          params: applicationIdParamSchema,
          response: { 200: applicationDetailSchema },
        },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const account = requireRole(request, "TUTOR", "STUDENT");
        const { id } = request.params as ApplicationIdParam;
        await transitionApplication(account, id, action);
        const detail = await getApplicationForCaller(id, account);
        reply.header("Cache-Control", "private, no-store");
        return reply.send(detail);
      },
    );
  }
}
