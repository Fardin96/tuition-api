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
