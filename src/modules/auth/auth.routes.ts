import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { appError, notFound } from "../../lib/errors.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAuth, requireRole } from "../../plugins/auth.js";
import {
  avatarResponseSchema,
  consentResultSchema,
  consentSchema,
  googleAuthSchema,
  logoutSchema,
  meSchema,
  refreshSchema,
  type SetAvatarInput,
  sessionListSchema,
  setAvatarSchema,
  tokenResponseSchema,
} from "./auth.schema.js";
import {
  createOrUpdateAccount,
  createSession,
  generateRefreshToken,
  getMe,
  hardDeleteAccount,
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
import { clearAvatar, setAvatar } from "./avatar.service.js";

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

// Every route here sets compress: false. Token responses and session lists are never compressed,
// which closes the compression side channels (BREACH-style) for secrets sent in these bodies.
export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/google",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Sign in or sign up with Google",
          description:
            "Verifies the Google ID token. Sign-up sends role (and optionally consentVersion); sign-in omits role. An unknown Google account with no role gets 404. A blocked account, or a deleted account signing in without a role, gets 403. Returns an access token and a refresh token.",
          auth: "public",
          errors: [403, 404],
        }),
        body: googleAuthSchema,
        response: { 200: tokenResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { idToken, role, consentVersion } = request.body as {
        idToken: string;
        role?: "STUDENT" | "TUTOR" | "ADMIN";
        consentVersion?: string;
      };
      const googlePayload = await verifyGoogleIdToken(idToken);
      const { account } = await createOrUpdateAccount(googlePayload, role, consentVersion);

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
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Rotate the refresh token",
          description:
            "Revokes the old refresh token and returns a new access token and refresh token. Returns 401 UNAUTHORIZED when the token is unknown, revoked or expired, or the account is not ACTIVE.",
          auth: "public",
          errors: [401],
        }),
        body: refreshSchema,
        response: { 200: tokenResponseSchema },
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
        throw appError("Unauthorized", 401, "Invalid or expired refresh token");
      }
    },
  );

  app.post(
    "/logout",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Sign out this session",
          description:
            "Revokes the session for the refresh token in the body, if one is sent. No access token needed. Always 204.",
          auth: "public",
          noContent: true,
        }),
        body: logoutSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as z.infer<typeof logoutSchema>;
      const refreshToken = body?.refreshToken;
      if (refreshToken) {
        await revokeSessionByToken(refreshToken);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    "/logout-all",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Sign out every session",
          description: "Revokes all of the account's sessions, on every device.",
          auth: "any",
          noContent: true,
        }),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      await revokeAllSessions(account.accountId);
      return reply.status(204).send();
    },
  );

  app.get(
    "/sessions",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "List my signed-in devices",
          description: "Active (not revoked) sessions, most recently used first.",
          auth: "any",
        }),
        response: { 200: sessionListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const sessions = await listSessions(account.accountId);
      return reply.send({ sessions });
    },
  );

  app.delete(
    "/sessions/:id",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Revoke one of my sessions",
          description: "Signs out one device. 404 when the session is not this account's.",
          auth: "any",
          errors: [404],
          noContent: true,
        }),
        params: paramsSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const { id } = request.params as { id: string };
      const revoked = await revokeSessionById(account.accountId, id);
      if (!revoked) throw notFound("Session not found");
      return reply.status(204).send();
    },
  );

  app.post(
    "/consent",
    {
      compress: false,
      schema: {
        ...routeDocs({
          tag: "Auth",
          summary: "Record consent",
          description: "Stores the consent version and the time it was accepted.",
          auth: ["STUDENT", "TUTOR"],
        }),
        body: consentSchema,
        response: { 200: consentResultSchema },
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

function transformMe(me: Awaited<ReturnType<typeof getMe>>) {
  if (!me) return me;
  return {
    ...me,
    tutor: me.tutor
      ? { ...me.tutor, needsReaddress: me.tutor.location?.needsReaddress ?? false }
      : undefined,
    student: me.student
      ? { ...me.student, needsReaddress: me.student.location?.needsReaddress ?? false }
      : undefined,
  };
}

export async function meRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "Get my account and profile",
          description:
            "The account, plus the student or tutor profile when one exists. A tutor payload adds applyReadiness {ready, missing[], verificationRequired}.",
          auth: "any",
        }),
        response: { 200: meSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      const me = await getMe(account.accountId);
      return reply.send({ account: transformMe(me) });
    },
  );

  app.delete(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "Delete my account",
          description:
            "Soft-delete. Frees the phone and WhatsApp numbers, closes open requirements, withdraws pending applications and revokes sessions. 403 for a blocked account.",
          auth: "any",
          errors: [403],
          noContent: true,
        }),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      await softDeleteAccount(account.accountId);
      return reply.status(204).send();
    },
  );

  app.delete(
    "/hard-delete",
    {
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "Permanently delete my account",
          description: "Removes the account and its rows. This cannot be undone.",
          auth: "any",
          noContent: true,
        }),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireAuth(request);
      await hardDeleteAccount(account.accountId);
      return reply.status(204).send();
    },
  );

  app.put(
    "/avatar",
    {
      config: accountRateLimit(10, "1 hour", "Too many photo changes. Try again later."),
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "Set my profile photo",
          description:
            "Uses an uploaded AVATAR file (JPEG, PNG or WebP, 2 MB) as the profile photo. The previous photo is deleted. Students and tutors only.",
          auth: ["STUDENT", "TUTOR"],
          errors: [400, 403, 409],
          rateLimit: "10/hour per account",
        }),
        body: setAvatarSchema,
        response: { 200: avatarResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireRole(request, "STUDENT", "TUTOR");
      const account = requireAuth(request);
      const { fileId } = request.body as SetAvatarInput;
      return reply.send(await setAvatar(account.accountId, fileId));
    },
  );

  app.delete(
    "/avatar",
    {
      config: accountRateLimit(30, "1 hour", "Too many photo changes. Try again later."),
      schema: {
        ...routeDocs({
          tag: "Account",
          summary: "Remove my profile photo",
          description:
            "Deletes the uploaded profile photo. The Google picture from the last sign-in shows again, if there is one. Students and tutors only.",
          auth: ["STUDENT", "TUTOR"],
          errors: [403],
          rateLimit: "30/hour per account",
        }),
        response: { 200: avatarResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireRole(request, "STUDENT", "TUTOR");
      const account = requireAuth(request);
      return reply.send(await clearAvatar(account.accountId));
    },
  );
}
