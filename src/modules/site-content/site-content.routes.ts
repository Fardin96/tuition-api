import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { sharedCache } from "../../plugins/cache.js";
import {
  type PageSlugParam,
  pageSlugParamSchema,
  siteContentSchema,
  sitePageSchema,
} from "./site-content.schema.js";
import { getSiteContent, getSitePage } from "./site-content.service.js";

const CACHE_SECONDS = 300;

export async function siteContentRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Site content",
          summary: "Get the landing page content",
          description:
            "The ten landing blocks: hero, nav, categories, testimonials, showcase, how_it_works, faq, cta_banner, footer and seo. A block with no row, or a stored row that no longer fits, shows its default. The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "120/min per account",
        }),
        response: { 200: siteContentSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const content = await getSiteContent();
      sharedCache(request, reply, CACHE_SECONDS);
      return reply.send(content);
    },
  );

  app.get(
    "/pages/:slug",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Site content",
          summary: "Get a static page",
          description:
            "One of about-us, terms, privacy or contact. updatedAt is null while the page shows its default. The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "120/min per account",
        }),
        params: pageSlugParamSchema,
        response: { 200: sitePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { slug } = request.params as PageSlugParam;
      const page = await getSitePage(slug);
      sharedCache(request, reply, CACHE_SECONDS);
      return reply.send(page);
    },
  );
}
