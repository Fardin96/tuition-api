import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateReportInput,
  createReportSchema,
  type MyReportListQuery,
  myReportListQuerySchema,
  myReportPageSchema,
  myReportSchema,
} from "./report.schema.js";
import { createReport, listMyReports } from "./report.service.js";

// Reports about another account, mounted at /api/v1/reports.
export async function reportRoutes(app: FastifyInstance) {
  app.post(
    "/",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Reports",
          summary: "Report an account",
          description:
            "#71. Reports another student or tutor to the admins. Send targetAccountId, applicationId, or both; with only applicationId the other party of that application is reported. 400 when neither is sent or the target is the caller, 404 when the account does not exist (or the caller is not a party of the application, or the target is not the other party), 409 REPORT_NOT_ALLOWED for an admin account and 409 REPORT_EXISTS while an earlier report about the same account is still open.",
          auth: ["STUDENT", "TUTOR"],
          errors: [404, 409],
          rateLimit: "10/min per account",
        }),
        body: createReportSchema,
        response: { 201: myReportSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const body = request.body as CreateReportInput;
      const report = await createReport(account, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(201).send(report);
    },
  );

  app.get(
    "/mine",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Reports",
          summary: "List my reports",
          description:
            "#72. Reports the caller filed, newest first. Cursor-paginated (limit 1 to 100, default 25). resolutionNote is shown once the report is resolved or dismissed.",
          auth: ["STUDENT", "TUTOR"],
          rateLimit: "300/min per account",
        }),
        querystring: myReportListQuerySchema,
        response: { 200: myReportPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const query = request.query as MyReportListQuery;
      reply.header("Cache-Control", "private, no-store");
      return reply.send(await listMyReports(account, query));
    },
  );
}
