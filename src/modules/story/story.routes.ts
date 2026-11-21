import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "../../lib/errors.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type CreateStoryInput,
  createStorySchema,
  type StoryIdParam,
  storyIdParamSchema,
  storyListSchema,
  storySchema,
} from "./story.schema.js";
import { createStory, deleteStory, listStories, requireStoryProfile } from "./story.service.js";

// Mounted at /api/v1/me/stories. Students and tutors with a profile only.
export async function storyRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Stories",
          summary: "List my stories",
          description:
            "Your stories, newest first, with a limit of 3 (any status) and one pending review at a time. canSubmit and blockedReason (LIMIT or PENDING) say whether a new one can be sent. note is the admin's note only when it was shared with you. onLanding is true while a testimonials or showcase card on the landing page uses the story.",
          auth: ["STUDENT", "TUTOR"],
          errors: [403],
        }),
        response: { 200: storyListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      await requireStoryProfile(account.accountId, account.role as "STUDENT" | "TUTOR");
      return reply.send(await listStories(account.accountId));
    },
  );

  app.post(
    "/",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Stories",
          summary: "Send a story for review",
          description:
            "Students send a headline (one line, 85 characters at most), a body (700 characters and 90 words at most), an optional photo and an optional video (mp4 or webm, 25 MB). Tutors send a body (300 characters at most) and an optional photo; a tutor sending a headline or a video gets 400. consent must be true. Files must be yours, purpose STORY_IMAGE or STORY_VIDEO, and finished uploading. Answers 201 with the story, which waits for an admin. 409 STORY_LIMIT_REACHED at 3 stories, 409 STORY_PENDING while another waits for a decision.",
          auth: ["STUDENT", "TUTOR"],
          errors: [400, 403, 409],
          rateLimit: "10/min per account",
        }),
        body: createStorySchema,
        response: { 201: storySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const role = account.role as "STUDENT" | "TUTOR";
      await requireStoryProfile(account.accountId, role);
      const body = request.body as CreateStoryInput;
      const story = await createStory(account.accountId, role, body);
      return reply.status(201).send(story);
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        ...routeDocs({
          tag: "Stories",
          summary: "Delete one of my stories",
          description:
            "Removes the story and its files. A card on the landing page that uses it is removed first. Replies 204 with no body. 404 when the story is not yours.",
          auth: ["STUDENT", "TUTOR"],
          errors: [403, 404],
          noContent: true,
        }),
        params: storyIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const { id } = request.params as StoryIdParam;
      const deleted = await deleteStory(account.accountId, id);
      if (!deleted) {
        throw notFound("Story not found");
      }
      return reply.status(204).send();
    },
  );
}
