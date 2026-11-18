import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminBlogListQuery,
  adminBlogListQuerySchema,
  adminBlogPostPageSchema,
  adminBlogPostSchema,
  type BlogPostIdParam,
  blogPostIdParamSchema,
  type CreateBlogPostInput,
  createBlogPostSchema,
  type UpdateBlogPostInput,
  updateBlogPostSchema,
} from "./blog.schema.js";
import {
  createBlogPost,
  deleteBlogPost,
  getAdminBlogPost,
  listAdminBlogPosts,
  updateBlogPost,
} from "./blog.service.js";

export async function adminBlogRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List blog posts",
          description:
            "Drafts, published and archived posts, most recently updated first. Optional status filter. Cursor-paginated (limit 1 to 100, default 20).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminBlogListQuerySchema,
        response: { 200: adminBlogPostPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminBlogListQuery;
      return reply.send(await listAdminBlogPosts(query));
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get one blog post",
          description: "Any post, whatever its status.",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: blogPostIdParamSchema,
        response: { 200: adminBlogPostSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as BlogPostIdParam;
      return reply.send(await getAdminBlogPost(id));
    },
  );

  app.post(
    "/",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Create a blog post",
          description:
            "Starts as a draft unless status is PUBLISHED. The slug comes from the title when omitted. coverFileId must be a cover image you uploaded (purpose BLOG_COVER). 409 BLOG_SLUG_EXISTS when the slug is taken.",
          auth: "admin",
          errors: [400, 409],
          rateLimit: "60/min per account",
        }),
        body: createBlogPostSchema,
        response: { 201: adminBlogPostSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const body = request.body as CreateBlogPostInput;
      const created = await createBlogPost(body, admin, request.ip);
      return reply.code(201).send(created);
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Update a blog post",
          description:
            "Any field can change. The first move to PUBLISHED sets publishedAt, which later edits keep. coverFileId null removes the cover; the old file is cleaned up later. 409 BLOG_SLUG_EXISTS when a new slug is taken.",
          auth: "admin",
          errors: [400, 404, 409],
          rateLimit: "60/min per account",
        }),
        params: blogPostIdParamSchema,
        body: updateBlogPostSchema,
        response: { 200: adminBlogPostSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as BlogPostIdParam;
      const body = request.body as UpdateBlogPostInput;
      return reply.send(await updateBlogPost(id, body, admin, request.ip));
    },
  );

  app.delete(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Delete a draft blog post",
          description:
            "Drafts only. Archive a published post instead. The cover file is deleted with the draft. Replies 204 with no body.",
          auth: "admin",
          errors: [404, 409],
          noContent: true,
          rateLimit: "60/min per account",
        }),
        params: blogPostIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as BlogPostIdParam;
      await deleteBlogPost(id, admin, request.ip);
      return reply.status(204).send();
    },
  );
}
