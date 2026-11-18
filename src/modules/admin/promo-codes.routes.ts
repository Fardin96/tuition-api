import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  adminPromoCodeDetailSchema,
  adminPromoCodePageSchema,
  type CreatePromoCodeInput,
  createPromoCodeSchema,
  type PromoCodeIdParam,
  type PromoCodeListQuery,
  promoCodeIdParamSchema,
  promoCodeListQuerySchema,
  type UpdatePromoCodeInput,
  updatePromoCodeSchema,
} from "./promo-codes.schema.js";
import {
  createPromoCode,
  getPromoCode,
  listPromoCodes,
  updatePromoCode,
} from "./promo-codes.service.js";

export async function adminPromoCodeRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/promo-codes",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List promo codes",
          description:
            "Newest first. ?active=true or ?active=false filters on isActive. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: promoCodeListQuerySchema,
        response: { 200: adminPromoCodePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as PromoCodeListQuery;
      const result = await listPromoCodes(query);
      return reply.send(result);
    },
  );

  app.post(
    "/promo-codes",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Create a promo code",
          description:
            "Super admins only. The code is stored uppercase and is unique case-insensitively. A PERCENT code takes a value up to 100 and an optional maxDiscount cap; a FLAT code takes a taka value and no cap. 409 PROMO_CODE_EXISTS when the code is taken.",
          auth: "admin",
          errors: [409],
          rateLimit: "30/min per account",
        }),
        body: createPromoCodeSchema,
        response: { 201: adminPromoCodeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const body = request.body as CreatePromoCodeInput;
      const created = await createPromoCode(body, admin, request.ip);
      return reply.code(201).send(created);
    },
  );

  app.get(
    "/promo-codes/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get a promo code with its latest redemptions",
          description: "Includes redemptionCount and the latest 50 redemptions, newest first.",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: promoCodeIdParamSchema,
        response: { 200: adminPromoCodeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as PromoCodeIdParam;
      const promoCode = await getPromoCode(id);
      return reply.send(promoCode);
    },
  );

  app.patch(
    "/promo-codes/:id",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Change a promo code's end, limits or status",
          description:
            "Super admins only. Changes description, endsAt (null clears it; must be in the future and after startsAt), maxRedemptions (null clears it), maxPerTutor and isActive. Discount terms cannot be changed.",
          auth: "admin",
          errors: [404],
          rateLimit: "30/min per account",
        }),
        params: promoCodeIdParamSchema,
        body: updatePromoCodeSchema,
        response: { 200: adminPromoCodeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { id } = request.params as PromoCodeIdParam;
      const body = request.body as UpdatePromoCodeInput;
      const updated = await updatePromoCode(id, body, admin, request.ip);
      return reply.send(updated);
    },
  );
}
