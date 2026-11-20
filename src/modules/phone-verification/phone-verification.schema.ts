import { z } from "zod";

// Bangladeshi mobile numbers in E.164, e.g. +8801712345678.
export const bdMobileSchema = z
  .string()
  .regex(/^\+8801[3-9]\d{8}$/, "Enter a Bangladeshi mobile number");

export const sendPhoneOtpSchema = z
  .object({ phoneNumber: bdMobileSchema })
  .meta({ id: "SendPhoneOtp" });
export type SendPhoneOtpInput = z.infer<typeof sendPhoneOtpSchema>;

export const verifyPhoneOtpSchema = z
  .object({
    phoneNumber: bdMobileSchema,
    code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
  })
  .meta({ id: "VerifyPhoneOtp" });
export type VerifyPhoneOtpInput = z.infer<typeof verifyPhoneOtpSchema>;

export const pendingPhoneVerificationSchema = z
  .object({
    phoneNumber: z.string(),
    verifiedAt: z.date(),
  })
  .meta({ id: "PendingPhoneVerification" });

export const phoneVerificationStatusSchema = z
  .object({
    /** The switch for the caller's role. */
    required: z.boolean(),
    /** From the caller's profile; null when there is no profile yet. */
    phoneNumber: z.string().nullable(),
    verifiedAt: z.date().nullable(),
    /** Only without a profile: a verified code still waiting to be used when the profile is created. */
    pendingVerification: pendingPhoneVerificationSchema.nullable(),
  })
  .meta({ id: "PhoneVerificationStatus" });
export type PhoneVerificationStatusResponse = z.infer<typeof phoneVerificationStatusSchema>;

export const phoneOtpSentSchema = z
  .object({
    phoneNumber: z.string(),
    expiresAt: z.date(),
    /** The earliest time another code can be sent to this number from this account. */
    resendAfter: z.date(),
  })
  .meta({ id: "PhoneOtpSent" });
export type PhoneOtpSentResponse = z.infer<typeof phoneOtpSentSchema>;

export const phoneVerifiedSchema = z
  .object({
    phoneNumber: z.string(),
    verifiedAt: z.date(),
  })
  .meta({ id: "PhoneVerified" });
export type PhoneVerifiedResponse = z.infer<typeof phoneVerifiedSchema>;
