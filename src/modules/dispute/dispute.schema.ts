import { z } from "zod";
import { DisputeType, Role } from "../../generated/prisma/enums.js";

export const createDisputeSchema = z
  .object({
    applicationId: z.string().uuid(),
    type: z.nativeEnum(DisputeType),
    details: z.string().trim().min(10).max(2000),
  })
  .strict()
  .meta({ id: "CreateDispute" });
export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;

export const myDisputeListQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type MyDisputeListQuery = z.infer<typeof myDisputeListQuerySchema>;

// The raiser's view of their own dispute. Never includes who handled it.
export const myDisputeSchema = z
  .object({
    id: z.string(),
    applicationId: z.string(),
    type: z.nativeEnum(DisputeType),
    details: z.string(),
    status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]),
    createdAt: z.date(),
    resolvedAt: z.date().nullable(),
    resolutionNote: z.string().nullable(),
    against: z.object({
      accountId: z.string(),
      role: z.nativeEnum(Role),
      name: z.string().nullable(),
    }),
  })
  .meta({ id: "MyDispute" });
export type MyDisputeResponse = z.infer<typeof myDisputeSchema>;

export const myDisputePageSchema = z
  .object({
    disputes: z.array(myDisputeSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "MyDisputePage" });
export type MyDisputePageResponse = z.infer<typeof myDisputePageSchema>;
