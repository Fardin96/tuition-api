import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminStoryListQuery,
  adminStoryListQuerySchema,
  adminStoryPageSchema,
  adminStorySchema,
  type ModerateStoryInput,
  moderateStorySchema,
  type StoryIdParam,
  storyIdParamSchema,
} from "./stories.schema.js";
import { listAdminStories, moderateStory } from "./stories.service.js";

// Author stories for review, mounted at /api/v1/admin/stories.
export async function adminStoryRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List author stories",
          description:
            "status defaults to PENDING. Newest first for every status. role narrows to STUDENT or TUTOR stories. Cursor-paginated (limit 1 to 100, default 25). onLanding is true while a testimonials or showcase card uses the story.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminStoryListQuerySchema,
        response: { 200: adminStoryPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminStoryListQuery;
      return reply.send(await listAdminStories(query));
    },
  );

  app.post(
    "/:id/moderate",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a story",
          description:
            "APPROVE publishes the story's photo and clip. REJECT needs a note that tells the author why, takes the story off the landing page if a card uses it, and takes its files down. noteVisible false keeps the note between admins: the author sees a generic message. Each decision sends the author an alert (STORY_APPROVED or STORY_REJECTED). 409 STORY_ALREADY_MODERATED when the story already has that decision.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: storyIdParamSchema,
        body: moderateStorySchema,
        response: { 200: adminStorySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as StoryIdParam;
      const body = request.body as ModerateStoryInput;
      return reply.send(await moderateStory(id, body, admin, request.ip));
    },
  );
}
