import { z } from "zod";
import { ApplicationStatus, ReportCategory } from "../../generated/prisma/enums.js";
import {
  adminHandlerSchema,
  adminPartySchema,
  caseQueueSchema,
  caseStatusSchema,
} from "./cases.js";

export const adminReportListQuerySchema = z.object({
  queue: caseQueueSchema,
  category: z.nativeEnum(ReportCategory).optional(),
  targetAccountId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminReportListQuery = z.infer<typeof adminReportListQuerySchema>;

export const adminReportSchema = z
  .object({
    id: z.string(),
    category: z.nativeEnum(ReportCategory),
    details: z.string(),
    status: caseStatusSchema,
    createdAt: z.date(),
    resolvedAt: z.date().nullable(),
    resolutionNote: z.string().nullable(),
    reporter: adminPartySchema,
    target: adminPartySchema,
    applicationId: z.string().nullable(),
    handledBy: adminHandlerSchema.nullable(),
  })
  .meta({ id: "AdminReport" });
export type AdminReportResponse = z.infer<typeof adminReportSchema>;

export const adminReportPageSchema = z
  .object({
    reports: z.array(adminReportSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminReportPage" });
export type AdminReportPageResponse = z.infer<typeof adminReportPageSchema>;

export const adminReportDetailSchema = adminReportSchema
  .extend({
    targetOpenReports: z.number().int(),
    targetReportCount: z.number().int(),
    targetActiveBlock: z.object({ reason: z.string(), blockedAt: z.date() }).nullable(),
    application: z
      .object({
        id: z.string(),
        status: z.nativeEnum(ApplicationStatus),
        confirmedAt: z.date().nullable(),
      })
      .nullable(),
  })
  .meta({ id: "AdminReportDetail" });
export type AdminReportDetailResponse = z.infer<typeof adminReportDetailSchema>;
