import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateDisputeInput,
  createDisputeSchema,
  type MyDisputeListQuery,
  myDisputeListQuerySchema,
  myDisputePageSchema,
  myDisputeSchema,
} from "./dispute.schema.js";
import { createDispute, listMyDisputes } from "./dispute.service.js";

// Disputes inside a running match, mounted at /api/v1/disputes.
export async function disputeRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Disputes",
          summary: "Raise a dispute",
          description:
            "#73. Either party of a confirmed or completed tuition raises a problem (no-show, quality, payment). The other party is taken from the application. 404 when the caller is not a party, 409 DISPUTE_NOT_ALLOWED for any other status and 409 DISPUTE_EXISTS while the caller's earlier dispute on this tuition is still open.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404, 409],
          rateLimit: "10/min per account",
        }),
        body: createDisputeSchema,
        response: { 201: myDisputeSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const body = request.body as CreateDisputeInput;
      const dispute = await createDispute(account, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(dispute);
    },
  );

  app.get(
    "/mine",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Disputes",
          summary: "List my disputes",
          description:
            "#74. Disputes the caller raised, newest first, optionally for one application (404 when the caller is not a party). Cursor-paginated (limit 1 to 100, default 25). resolutionNote is shown once the dispute is resolved or dismissed.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        querystring: myDisputeListQuerySchema,
        response: { 200: myDisputePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const query = request.query as MyDisputeListQuery;
      reply.header("Cache-Control", "private, no-store");
      return reply.send(await listMyDisputes(account, query));
    },
  );
}
