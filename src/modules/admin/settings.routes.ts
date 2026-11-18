import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  platformSettingItemSchema,
  platformSettingListSchema,
  type SettingKeyParam,
  settingKeyParamSchema,
  type UpdateSettingInput,
  updateSettingSchema,
} from "./settings.schema.js";
import { listPlatformSettings, updatePlatformSetting } from "./settings.service.js";

export async function adminSettingRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List platform settings",
          description:
            "The three known settings in a fixed order. A key with no row yet shows its default (commission_percent 0, the two switches false).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: platformSettingListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const settings = await listPlatformSettings();
      return reply.send({ settings });
    },
  );

  app.put(
    "/:key",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Update a platform setting",
          description:
            "Super admin only. commission_percent takes 0 to 100 with at most 2 decimals. The switches take true or false. Changing require_tutor_verification re-evaluates every tutor's listing.",
          auth: "admin",
          rateLimit: "60/min per account",
        }),
        params: settingKeyParamSchema,
        body: updateSettingSchema,
        response: { 200: platformSettingItemSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { key } = request.params as SettingKeyParam;
      const { value } = request.body as UpdateSettingInput;
      const updated = await updatePlatformSetting(key, value, admin, request.ip);
      return reply.send(updated);
    },
  );
}
