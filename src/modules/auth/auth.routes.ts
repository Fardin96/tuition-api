import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../../plugins/auth.js";
import { consentSchema, googleAuthSchema, refreshSchema } from "./auth.schema.js";
import {
  createOrUpdateAccount,
  createSession,
  generateRefreshToken,
  getMe,
  listSessions,
  recordConsent,
  revokeAllSessions,
  revokeSessionById,
  revokeSessionByToken,
  rotateRefreshToken,
  signAccessToken,
  softDeleteAccount,
  verifyGoogleIdToken,
} from "./auth.service.js";

const paramsSchema = z.object({ id: z.string().uuid() });

async function buildTokenResponse(account: {
  id: string;
  role: string;
  email: string;
  status: string;
}) {
  const accessToken = await signAccessToken({
    accountId: account.id,
    role: account.role as "STUDENT" | "TUTOR" | "ADMIN",
    email: account.email,
  });
  const refreshToken = generateRefreshToken();
  return { accessToken, refreshToken, account };
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/google",
    {
      schema: {
        body: googleAuthSchema,
        response: {
          200: z.object({
            accessToken: z.string(),
            refreshToken: z.string(),
            account: z.object({
              id: z.string(),
              role: z.string(),
              email: z.string(),
              status: z.string(),
            }),
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { idToken, role, consentVersion } = request.body as {
        idToken: string;
        role: string;
        consentVersion?: string;
      };
      const googlePayload = await verifyGoogleIdToken(idToken);
      const { account } = await createOrUpdateAccount(
        googlePayload,
        role as "STUDENT" | "TUTOR" | "ADMIN",
        consentVersion,
      );

      const tokens = await buildTokenResponse(account);
      await createSession(account.id, tokens.refreshToken, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? undefined,
      });

      return reply.send(tokens);
    },
  );

  app.post(
    "/refresh",
    {
      schema: {
        body: refreshSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { refreshToken } = request.body as { refreshToken: string };
      try {
        const { newToken, account } = await rotateRefreshToken(refreshToken, {
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? undefined,
        });
        const accessToken = await signAccessToken({
          accountId: account.id,
          role: account.role,
          email: account.email,
        });
        return reply.send({
          accessToken,
          refreshToken: newToken,
          account: {
            id: account.id,
            role: account.role,
            email: account.email,
            status: account.status,
          },
        });
      } catch {
        return reply
          .status(401)
          .send({ error: "Unauthorized", message: "Invalid or expired refresh token" });
      }
    },
  );

  app.post("/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { refreshToken?: string } | undefined;
    const refreshToken = body?.refreshToken;
    if (refreshToken) {
      await revokeSessionByToken(refreshToken);
    }
    return reply.status(204).send();
  });

  app.post("/logout-all", async (request: FastifyRequest, reply: FastifyReply) => {
    const account = requireAuth(request);
    await revokeAllSessions(account.accountId);
    return reply.status(204).send();
  });

  app.get("/sessions", async (request: FastifyRequest, reply: FastifyReply) => {
    const account = requireAuth(request);
    const sessions = await listSessions(account.accountId);
    return reply.send({ sessions });
  });

  app.delete(
    "/sessions/:id",
    {
      schema: {
        params: paramsSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as { id: string };
      const revoked = await revokeSessionById(account.accountId, id);
      if (!revoked) {
        return reply.status(404).send({ error: "NotFound", message: "Session not found" });
      }
      return reply.status(204).send();
    },
  );

  app.post(
    "/consent",
    {
      schema: {
        body: consentSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireRole(request, "STUDENT", "TUTOR");
      const account = requireAuth(request);
      const { version } = request.body as { version: string };
      const updated = await recordConsent(account.accountId, version);
      return reply.send({
        consentVersion: updated.consentVersion,
        consentAcceptedAt: updated.consentAcceptedAt?.toISOString() ?? null,
      });
    },
  );
}

export async function meRoutes(app: FastifyInstance) {
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const account = requireAuth(request);
    const me = await getMe(account.accountId);
    return reply.send({ account: me });
  });

  app.delete("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const account = requireAuth(request);
    await softDeleteAccount(account.accountId);
    return reply.status(204).send();
  });
}
