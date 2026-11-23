import { z } from "zod";
import { AdminRole, AdminStatus } from "../../generated/prisma/enums.js";

export const adminAccountIdParamSchema = z.object({ accountId: z.string().uuid() });
export type AdminAccountIdParam = z.infer<typeof adminAccountIdParamSchema>;

export const adminTeamMemberSchema = z
  .object({
    accountId: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    adminRole: z.nativeEnum(AdminRole),
    status: z.nativeEnum(AdminStatus),
    mfaEnabled: z.boolean(),
    approvedAt: z.date().nullable(),
    approvedByName: z.string().nullable(),
    removedAt: z.date().nullable(),
    createdAt: z.date(),
    lastLoginAt: z.date().nullable(),
  })
  .meta({ id: "AdminTeamMember" });
export type AdminTeamMember = z.infer<typeof adminTeamMemberSchema>;

export const adminTeamListSchema = z
  .object({ admins: z.array(adminTeamMemberSchema) })
  .meta({ id: "AdminTeamList" });

export const createAdminInviteSchema = z
  .object({ email: z.string().trim().toLowerCase().max(254).email() })
  .meta({ id: "CreateAdminInvite" });
export type CreateAdminInvite = z.infer<typeof createAdminInviteSchema>;

export const adminInviteIdParamSchema = z.object({ id: z.string().uuid() });
export type AdminInviteIdParam = z.infer<typeof adminInviteIdParamSchema>;

export const adminInviteSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    invitedByName: z.string(),
    createdAt: z.date(),
    expiresAt: z.date(),
    expired: z.boolean(),
  })
  .meta({ id: "AdminInvite" });
export type AdminInvite = z.infer<typeof adminInviteSchema>;

export const adminInviteListSchema = z
  .object({ invites: z.array(adminInviteSchema) })
  .meta({ id: "AdminInviteList" });
