import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAuth } from "../../plugins/auth.js";
import {
  type NotificationIdParam,
  type NotificationListQuery,
  notificationIdParamSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  unreadCountSchema,
} from "./notification.schema.js";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCountFor,
} from "./notification.service.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Notifications",
          summary: "List my notifications",
          description:
            "In-app alerts about my applications, newest first, keyset cursor. unreadCount counts all unread alerts, not just this page. Admins get an empty list.",
          auth: "any",
          rateLimit: "300/min per account",
        }),
        querystring: notificationListQuerySchema,
        response: { 200: notificationPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const query = request.query as NotificationListQuery;
      const page = await listNotifications(account, query);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(page);
    },
  );

  app.get(
    "/unread-count",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Notifications",
          summary: "Count my unread notifications",
          description: "Polled by the dashboard bell.",
          auth: "any",
          rateLimit: "300/min per account",
        }),
        response: { 200: unreadCountSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const result = await unreadCountFor(account);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );

  app.post(
    "/:id/read",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Notifications",
          summary: "Mark one notification as read",
          description:
            "Replies 204 with no body. Calling it again on a read alert is fine. Another account's alert is 404.",
          auth: "any",
          errors: [404],
          rateLimit: "120/min per account",
          noContent: true,
        }),
        params: notificationIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as NotificationIdParam;
      await markNotificationRead(account, id);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(204).send();
    },
  );

  app.post(
    "/read-all",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Notifications",
          summary: "Mark all my notifications as read",
          description: "Replies 204 with no body.",
          auth: "any",
          rateLimit: "60/min per account",
          noContent: true,
        }),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      await markAllNotificationsRead(account);
      reply.header("Cache-Control", "private, no-store");
      return reply.status(204).send();
    },
  );
}
