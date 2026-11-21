import { z } from "zod";
import { ApplicationStatus, Gender, VerificationStatus } from "../../generated/prisma/enums.js";

// A match card's reason. Shared by the tutor browse (scope=set) and the student's tutor list.
export const matchReasonSchema = z
  .object({ rule: z.string(), ok: z.boolean(), label: z.string() })
  .meta({ id: "MatchReason" });
export type MatchReasonResponse = z.infer<typeof matchReasonSchema>;

export const recommendedTutorsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(15).default(1),
});
export type RecommendedTutorsQuery = z.infer<typeof recommendedTutorsQuerySchema>;

export const requirementInviteBodySchema = z.object({
  tutorId: z.string().uuid(),
});
export type RequirementInviteBody = z.infer<typeof requirementInviteBodySchema>;

const recommendedTutorSchema = z.object({
  tutor: z.object({
    id: z.string(),
    name: z.string(),
    instituteName: z.string().nullable(),
    gender: z.nativeEnum(Gender),
    ratingAvg: z.number(),
    ratingCount: z.number().int(),
    verificationStatus: z.nativeEnum(VerificationStatus),
    areas: z.array(z.object({ id: z.number(), name: z.string() })),
    subjects: z.array(z.object({ id: z.number(), name: z.string() })),
  }),
  /** Why this tutor fits, worded for the student. No numeric score. */
  reasons: z.array(matchReasonSchema),
  /** When this student invited the tutor to the requirement, else null. */
  invitedAt: z.date().nullable(),
  /** The tutor's application on this requirement, any status. Null when there is none. */
  application: z.object({ id: z.string(), status: z.nativeEnum(ApplicationStatus) }).nullable(),
});

export const recommendedTutorPageSchema = z
  .object({
    tutors: z.array(recommendedTutorSchema),
    /** Listed tutors with a matching set, capped at 300 by the service. */
    total: z.number().int(),
    page: z.number().int(),
    hasMore: z.boolean(),
    /** Matching config version the scores and reasons were computed under. */
    matchVersion: z.number().int(),
    /** Only when total is below 3: what one change to the requirement would add tutors. */
    suggestions: z.array(
      z.object({
        code: z.enum(["ALLOW_ONLINE", "ANY_GENDER"]),
        extraTutors: z.number().int(),
      }),
    ),
  })
  .meta({ id: "RecommendedTutorPage" });
export type RecommendedTutorPageResponse = z.infer<typeof recommendedTutorPageSchema>;

export const requirementInviteSchema = z
  .object({
    id: z.string(),
    requirementId: z.string(),
    tutorId: z.string(),
    createdAt: z.date(),
  })
  .meta({ id: "RequirementInvite" });
export type RequirementInviteResponse = z.infer<typeof requirementInviteSchema>;
