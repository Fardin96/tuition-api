import { z } from "zod";

export const auditLogListQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.string().trim().min(1).max(100).optional(),
  actorAccountId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(80).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

export const auditLogEntrySchema = z
  .object({
    id: z.string(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    before: z.unknown(),
    after: z.unknown(),
    ip: z.string().nullable(),
    createdAt: z.date(),
    actor: z
      .object({
        accountId: z.string().uuid(),
        email: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "AuditLogEntry" });
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z
  .object({
    entries: z.array(auditLogEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AuditLogPage" });
