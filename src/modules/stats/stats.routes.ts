import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import { privateCache } from "../../plugins/cache.js";
import { myStatsSchema } from "./stats.schema.js";
import { getMyStats } from "./stats.service.js";

// Mounted at /api/v1/me/stats. Students and tutors only.
export async function statsRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "My dashboard counts",
          description:
            "Counts for the dashboard's At a glance row, by role. A tutor gets applicationsSent (applications the tutor sent, any status), activeStudents (distinct students with a CONFIRMED application) and invitesReceived (invites to OPEN requirements from ACTIVE students). A student gets openRequirements (its OPEN requirements), applicationsReceived (tutor applications on its requirements, any status) and tutorsHired (distinct tutors with a CONFIRMED or COMPLETED application). The tutor's rating is on /me.",
          auth: ["STUDENT", "TUTOR"],
        }),
        response: { 200: myStatsSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      privateCache(reply);
      return reply.send(await getMyStats(account));
    },
  );
}
