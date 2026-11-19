import { z } from "zod";
import { ApplicationStatus, DisputeType } from "../../generated/prisma/enums.js";
import {
  adminHandlerSchema,
  adminPartySchema,
  caseQueueSchema,
  caseStatusSchema,
} from "./cases.js";

export const adminDisputeListQuerySchema = z.object({
  queue: caseQueueSchema,
  type: z.nativeEnum(DisputeType).optional(),
  applicationId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminDisputeListQuery = z.infer<typeof adminDisputeListQuerySchema>;

export const adminDisputeSchema = z
  .object({
    id: z.string(),
    applicationId: z.string(),
    type: z.nativeEnum(DisputeType),
    details: z.string(),
    status: caseStatusSchema,
    createdAt: z.date(),
    resolvedAt: z.date().nullable(),
    resolutionNote: z.string().nullable(),
    raisedBy: adminPartySchema,
    against: adminPartySchema,
    handledBy: adminHandlerSchema.nullable(),
  })
  .meta({ id: "AdminDispute" });
export type AdminDisputeResponse = z.infer<typeof adminDisputeSchema>;

export const adminDisputePageSchema = z
  .object({
    disputes: z.array(adminDisputeSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminDisputePage" });
export type AdminDisputePageResponse = z.infer<typeof adminDisputePageSchema>;

export const adminDisputeDetailSchema = adminDisputeSchema
  .extend({
    application: z.object({
      id: z.string(),
      status: z.nativeEnum(ApplicationStatus),
      confirmedAt: z.date().nullable(),
      endedAt: z.date().nullable(),
      tutorId: z.string(),
      studentId: z.string(),
    }),
    otherOpenDisputes: z.number().int(),
  })
  .meta({ id: "AdminDisputeDetail" });
export type AdminDisputeDetailResponse = z.infer<typeof adminDisputeDetailSchema>;
