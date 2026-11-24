import { z } from "zod";
import type { Role } from "../../generated/prisma/enums.js";
import { PROFILE_ITEM_KEYS } from "../../lib/profile-strength.js";

export const roleSchema = z.enum(["STUDENT", "TUTOR", "ADMIN"] as const);

export const googleAuthSchema = z
  .object({
    idToken: z.string().min(1),
    // Sign-up sends a role; sign-in omits it, so an unknown Google account is rejected, not created.
    role: roleSchema.optional(),
    consentVersion: z.string().optional(),
  })
  .meta({ id: "GoogleSignIn" });

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .meta({ id: "RefreshToken" });

export type RefreshInput = z.infer<typeof refreshSchema>;

// Body is optional. Fastify hands a body-less POST over as null, so nullish, not optional.
export const logoutSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .meta({ id: "Logout" })
  .nullish();

export const consentSchema = z
  .object({
    version: z.string().min(1),
  })
  .meta({ id: "Consent" });

export type ConsentInput = z.infer<typeof consentSchema>;

export const tokenResponseSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    account: z.object({
      id: z.string(),
      role: roleSchema,
      email: z.string(),
      status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]),
    }),
  })
  .meta({ id: "TokenResponse" });

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const consentResultSchema = z
  .object({
    consentVersion: z.string().nullable(),
    consentAcceptedAt: z.string().nullable(),
  })
  .meta({ id: "ConsentResult" });

// The profile picture. fileId is an UPLOADED AVATAR file the caller owns.
export const setAvatarSchema = z
  .object({
    fileId: z.string().uuid(),
  })
  .strict()
  .meta({ id: "SetAvatar" });

export type SetAvatarInput = z.infer<typeof setAvatarSchema>;

export const avatarResponseSchema = z
  .object({
    avatarUrl: z.string().nullable(),
  })
  .meta({ id: "Avatar" });

export const sessionSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.date(),
    lastUsedAt: z.date(),
    expiresAt: z.date(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .meta({ id: "Session" });

export const sessionListSchema = z
  .object({
    sessions: z.array(sessionSchema),
  })
  .meta({ id: "SessionList" });

// GET /me sends Prisma rows as they are (Date objects, Decimal ratings), so the dates are z.date()
// and the Decimal fields are z.any(). The zod serializer strips anything not listed here, which
// keeps googleSub and the encrypted MFA secret off the wire.
const decimalSchema = z
  .any()
  .meta({ type: "string", description: "Decimal, serialized as a string" });

const ownLocationSchema = z
  .object({
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    addressText: z.string(),
    districtCode: z.string(),
    districtName: z.string().nullable(),
    placeId: z.string().nullable(),
    needsReaddress: z.boolean(),
  })
  .nullable();

const applyReadinessSchema = z.object({
  ready: z.boolean(),
  missing: z.array(z.string()),
  verificationRequired: z.boolean(),
});

const meStudentSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    role: roleSchema,
    name: z.string(),
    areaId: z.number(),
    address: z.string(),
    emergencyContact: z.string(),
    whatsappNumber: z.string().nullable(),
    whatsappVerifiedAt: z.date().nullable(),
    phoneNumber: z.string(),
    phoneVerifiedAt: z.date().nullable(),
    studentIdNumber: z.string(),
    verificationFileId: z.string().uuid().nullable(),
    verificationStatus: z.enum(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]),
    verificationNote: z.string().nullable(),
    verificationSubmittedAt: z.date().nullable(),
    verificationDecidedAt: z.date().nullable(),
    ratingAvg: decimalSchema,
    ratingCount: z.number(),
    createdAt: z.date(),
    updatedAt: z.date(),
    location: ownLocationSchema,
    needsReaddress: z.boolean(),
  })
  .meta({ id: "MeStudent" });

const meTutorSchema = z
  .object({
    id: z.string().uuid(),
    accountId: z.string().uuid(),
    role: roleSchema,
    name: z.string(),
    instituteName: z.string().nullable(),
    institutionId: z.number().nullable(),
    address: z.string(),
    emergencyContact: z.string().nullable(),
    whatsappNumber: z.string().nullable(),
    whatsappVerifiedAt: z.date().nullable(),
    phoneNumber: z.string(),
    phoneVerifiedAt: z.date().nullable(),
    studentIdNumber: z.string().nullable(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]),
    parentsInfo: z.string().nullable(),
    zoneLimit: z.number(),
    verificationStatus: z.enum(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]),
    isListed: z.boolean(),
    ratingAvg: decimalSchema,
    ratingCount: z.number(),
    createdAt: z.date(),
    updatedAt: z.date(),
    location: ownLocationSchema,
    needsReaddress: z.boolean(),
  })
  .meta({ id: "MeTutor" });

const meAdminUserSchema = z
  .object({
    accountId: z.string().uuid(),
    role: roleSchema,
    name: z.string(),
    adminRole: z.enum(["ADMIN", "SUPER_ADMIN"]),
    status: z.enum(["PENDING", "ACTIVE", "REMOVED"]),
    approvedById: z.string().uuid().nullable(),
    approvedAt: z.date().nullable(),
    removedById: z.string().uuid().nullable(),
    removedAt: z.date().nullable(),
    mfaEnabled: z.boolean(),
    createdAt: z.date(),
  })
  .meta({ id: "MeAdminUser" });

export const profileStrengthSchema = z
  .object({
    percent: z.number(),
    complete: z.boolean(),
    completeAt: z.number(),
    verifiedBadge: z.boolean(),
    badgeAt: z.number(),
    items: z.array(
      z.object({ key: z.enum(PROFILE_ITEM_KEYS), weight: z.number(), done: z.boolean() }),
    ),
  })
  .meta({ id: "ProfileStrength" });

const meAccountSchema = z
  .object({
    id: z.string().uuid(),
    role: roleSchema,
    email: z.string(),
    status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]),
    consentVersion: z.string().nullable(),
    consentAcceptedAt: z.date().nullable(),
    createdAt: z.date(),
    lastLoginAt: z.date().nullable(),
    deletedAt: z.date().nullable(),
    // The uploaded photo, else the Google picture, else null. Only the URL leaves the API.
    avatarUrl: z.string().nullable(),
    adminUser: meAdminUserSchema.nullable(),
    student: meStudentSchema.optional(),
    tutor: meTutorSchema.optional(),
    applyReadiness: applyReadinessSchema.optional(),
    profileStrength: profileStrengthSchema.optional(),
  })
  .meta({ id: "MeAccount" });

export const meSchema = z
  .object({
    account: meAccountSchema,
  })
  .meta({ id: "Me" });

export type AuthContext = {
  accountId: string;
  role: Role;
  email: string;
};
