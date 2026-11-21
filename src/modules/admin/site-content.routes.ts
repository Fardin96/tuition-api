import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  adminSiteContentItemSchema,
  adminSiteContentListSchema,
  adminSiteSourceListSchema,
  type ResetSiteContentQuery,
  resetSiteContentQuerySchema,
  type SiteContentKeyParam,
  type SiteSourcesQuery,
  siteContentKeyParamSchema,
  siteSourcesQuerySchema,
  type UpdateSiteContentInput,
  updateSiteContentSchema,
} from "../site-content/site-content.schema.js";
import {
  listAdminSiteContent,
  listSiteSources,
  resetSiteContent,
  updateSiteContent,
} from "../site-content/site-content.service.js";

export async function adminSiteContentRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List site content",
          description:
            "Every landing block and static page in a fixed order, with the default, whether a row exists (isDefault) and who saved it last.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminSiteContentListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const items = await listAdminSiteContent();
      return reply.send({ items });
    },
  );

  app.get(
    "/sources",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List submissions that can be added to a card list",
          description:
            "for=testimonials lists approved student stories by active students. for=showcase lists approved tutor stories (comment cards) and approved tutor videos the tutor agreed to show on the home page (video cards). Newest first, at most 100. Each row says whether it is already on the landing page (onLanding). Adding one to a list is a PUT of that block with `source` set on the card.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: siteSourcesQuerySchema,
        response: { 200: adminSiteSourceListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { for: forKey } = request.query as SiteSourcesQuery;
      return reply.send({ sources: await listSiteSources(forKey) });
    },
  );

  app.put(
    "/:key",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Update a site content block",
          description:
            "Any admin. The whole block is replaced, so send every field. expectedUpdatedAt is the updatedAt the editor loaded, or null when it loaded the default. A mismatch answers 409 SITE_CONTENT_CONFLICT. Unknown fields are dropped. Saving the same value again changes nothing.",
          auth: "admin",
          errors: [400, 409],
          rateLimit: "60/min per account",
        }),
        params: siteContentKeyParamSchema,
        body: updateSiteContentSchema,
        response: { 200: adminSiteContentItemSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { key } = request.params as SiteContentKeyParam;
      const { value, expectedUpdatedAt } = request.body as UpdateSiteContentInput;
      const item = await updateSiteContent(key, value, expectedUpdatedAt, admin, request.ip);
      return reply.send(item);
    },
  );

  app.delete(
    "/:key",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Reset a site content block to its default",
          description:
            "Any admin. Deletes the row, so the block follows the defaults again. expectedUpdatedAt is optional; when sent and it does not match, answers 409 SITE_CONTENT_CONFLICT. A block with no row answers 200 with its default.",
          auth: "admin",
          errors: [409],
          rateLimit: "60/min per account",
        }),
        params: siteContentKeyParamSchema,
        querystring: resetSiteContentQuerySchema,
        response: { 200: adminSiteContentItemSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { key } = request.params as SiteContentKeyParam;
      const { expectedUpdatedAt } = request.query as ResetSiteContentQuery;
      const item = await resetSiteContent(key, expectedUpdatedAt, admin, request.ip);
      return reply.send(item);
    },
  );
}
