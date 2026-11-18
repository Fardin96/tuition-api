import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { publicCache } from "../../plugins/cache.js";
import {
  type BlogListQuery,
  type BlogSlugParam,
  blogListQuerySchema,
  blogPostPageSchema,
  blogPostSchema,
  blogSlugParamSchema,
} from "./blog.schema.js";
import { getPublishedPost, listPublishedPosts } from "./blog.service.js";

const CACHE = "public, max-age=300, stale-while-revalidate=600";

export async function blogRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Blog",
          summary: "List blog posts",
          description:
            "Published posts only, newest first. Cursor-paginated (limit 1 to 100, default 20).",
          auth: "optional",
          rateLimit: "120/min per account",
        }),
        querystring: blogListQuerySchema,
        response: { 200: blogPostPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as BlogListQuery;
      const page = await listPublishedPosts(query);
      publicCache(request, reply, CACHE);
      return reply.send(page);
    },
  );

  app.get(
    "/:slug",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Blog",
          summary: "Get a blog post",
          description: "One published post by slug. Drafts and archived posts answer 404.",
          auth: "optional",
          errors: [404],
          rateLimit: "120/min per account",
        }),
        params: blogSlugParamSchema,
        response: { 200: blogPostSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as BlogSlugParam;
      const post = await getPublishedPost(slug);
      publicCache(request, reply, CACHE);
      return reply.send(post);
    },
  );
}
