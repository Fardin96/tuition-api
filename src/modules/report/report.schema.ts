import { z } from "zod";
import { ReportCategory, Role } from "../../generated/prisma/enums.js";

export const createReportSchema = z
  .object({
    targetAccountId: z.string().uuid().optional(),
    category: z.nativeEnum(ReportCategory),
    details: z.string().trim().min(10).max(2000),
    applicationId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.targetAccountId && !v.applicationId) {
      ctx.addIssue({
        code: "custom",
        path: ["targetAccountId"],
        message: "Pick who you're reporting.",
      });
    }
  })
  .meta({ id: "CreateReport" });
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const myReportListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type MyReportListQuery = z.infer<typeof myReportListQuerySchema>;

// The reporter's view of their own report. Never includes who handled it.
export const myReportSchema = z
  .object({
    id: z.string(),
    category: z.nativeEnum(ReportCategory),
    details: z.string(),
    status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]),
    createdAt: z.date(),
    resolvedAt: z.date().nullable(),
    resolutionNote: z.string().nullable(),
    target: z.object({
      accountId: z.string(),
      role: z.nativeEnum(Role),
      name: z.string().nullable(),
    }),
    applicationId: z.string().nullable(),
  })
  .meta({ id: "MyReport" });
export type MyReportResponse = z.infer<typeof myReportSchema>;

export const myReportPageSchema = z
  .object({
    reports: z.array(myReportSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "MyReportPage" });
export type MyReportPageResponse = z.infer<typeof myReportPageSchema>;
