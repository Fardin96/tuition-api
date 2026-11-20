import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  phoneOtpSentSchema,
  phoneVerificationStatusSchema,
  phoneVerifiedSchema,
  type SendPhoneOtpInput,
  sendPhoneOtpSchema,
  type VerifyPhoneOtpInput,
  verifyPhoneOtpSchema,
} from "./phone-verification.schema.js";
import {
  getPhoneVerificationStatus,
  sendPhoneOtp,
  verifyPhoneOtp,
} from "./phone-verification.service.js";

// Students and tutors prove they own a Bangladeshi mobile number. Mounted at /api/v1/phone-verification.
export async function phoneVerificationRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: accountRateLimit(120, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Phone verification",
          summary: "Get my phone verification status",
          description:
            "required is the switch for my role (students and tutors have separate switches). phoneNumber and verifiedAt come from my profile and are null when I have no profile yet. Without a profile, pendingVerification is the latest code I verified in the last 30 minutes that no profile has used yet (null otherwise), so onboarding can resume after a reload.",
          auth: ["STUDENT", "TUTOR"],
          rateLimit: "120/min per account",
        }),
        response: { 200: phoneVerificationStatusSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const status = await getPhoneVerificationStatus(account);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(status);
    },
  );

  app.post(
    "/send",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Phone verification",
          summary: "Send a verification code by SMS",
          description:
            "Sends a 6-digit code that expires in 5 minutes. Limits: one code per 60 seconds per number (429 OTP_COOLDOWN with details.retryAfterSeconds), 5 codes per number and 10 per account in a rolling hour (429 OTP_SEND_LIMIT). 409 PHONE_IN_USE when another account has the number, 409 PHONE_ALREADY_VERIFIED when it is already verified on my profile. 503 SMS_UNAVAILABLE when the SMS provider fails.",
          auth: ["STUDENT", "TUTOR"],
          errors: [409, 503],
          rateLimit: "10/min per account",
        }),
        body: sendPhoneOtpSchema,
        response: { 200: phoneOtpSentSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const body = request.body as SendPhoneOtpInput;
      const sent = await sendPhoneOtp(account, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(sent);
    },
  );

  app.post(
    "/verify",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Phone verification",
          summary: "Verify the code I received",
          description:
            "A wrong code gives 400 OTP_INVALID with details.attemptsLeft. After 5 wrong codes the code is locked (429 OTP_TOO_MANY_ATTEMPTS) until a new one is sent. An expired code gives 400 OTP_EXPIRED. Once a newer code has been sent, an older one no longer matches (400 OTP_INVALID). When I have a profile, verifying also sets its phone number to this one and marks it verified. Without a profile, the verification is kept for 30 minutes and used when I create the profile.",
          auth: ["STUDENT", "TUTOR"],
          errors: [400, 409],
          rateLimit: "30/min per account",
        }),
        body: verifyPhoneOtpSchema,
        response: { 200: phoneVerifiedSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "STUDENT", "TUTOR");
      const body = request.body as VerifyPhoneOtpInput;
      const verified = await verifyPhoneOtp(account, body);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(verified);
    },
  );
}
