import { z } from "zod";
import {
  AccountStatus,
  AdminRole,
  AdminStatus,
  Role,
  VerificationStatus,
} from "../../generated/prisma/enums.js";

export const accountIdParamSchema = z.object({ id: z.string().uuid() });
export type AccountIdParam = z.infer<typeof accountIdParamSchema>;

export const accountListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["STUDENT", "TUTOR", "ADMIN"]).optional(),
  status: z.enum(["ACTIVE", "BLOCKED", "DELETED"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

const summaryShape = {
  id: z.string().uuid(),
  email: z.string(),
  role: z.nativeEnum(Role),
  status: z.nativeEnum(AccountStatus),
  name: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  createdAt: z.date(),
  lastLoginAt: z.date().nullable(),
  deletedAt: z.date().nullable(),
};

export const adminAccountSummarySchema = z.object(summaryShape).meta({ id: "AdminAccountSummary" });
export type AdminAccountSummary = z.infer<typeof adminAccountSummarySchema>;

export const adminAccountPageSchema = z
  .object({
    accounts: z.array(adminAccountSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminAccountPage" });

const adminActiveBlockSchema = z
  .object({
    id: z.string().uuid(),
    reason: z.string(),
    blockedAt: z.date(),
    blockedByName: z.string().nullable(),
  })
  .meta({ id: "AdminActiveBlock" });

const adminAccountBlockSchema = z
  .object({
    id: z.string().uuid(),
    reason: z.string(),
    blockedAt: z.date(),
    blockedByName: z.string().nullable(),
    unblockedAt: z.date().nullable(),
    unblockedByName: z.string().nullable(),
  })
  .meta({ id: "AdminAccountBlock" });

export const adminAccountDetailSchema = z
  .object({
    ...summaryShape,
    consentVersion: z.string().nullable(),
    consentAcceptedAt: z.date().nullable(),
    studentId: z.string().uuid().nullable(),
    tutorId: z.string().uuid().nullable(),
    whatsappNumber: z.string().nullable(),
    verificationStatus: z.nativeEnum(VerificationStatus).nullable(),
    isListed: z.boolean().nullable(),
    instituteName: z.string().nullable(),
    adminRole: z.nativeEnum(AdminRole).nullable(),
    adminStatus: z.nativeEnum(AdminStatus).nullable(),
    activeBlock: adminActiveBlockSchema.nullable(),
    blocks: z.array(adminAccountBlockSchema),
    counts: z.object({
      applications: z.number().int(),
      openRequirements: z.number().int(),
      openPackages: z.number().int(),
    }),
  })
  .meta({ id: "AdminAccountDetail" });
export type AdminAccountDetail = z.infer<typeof adminAccountDetailSchema>;

export const blockAccountSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict()
  .meta({ id: "BlockAccount" });
export type BlockAccountInput = z.infer<typeof blockAccountSchema>;
