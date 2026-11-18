import { z } from "zod";
import {
  ApplicationStatus,
  Curriculum,
  FeeStatus,
  InitiatedBy,
} from "../../generated/prisma/enums.js";

export const adminApplicationListQuerySchema = z.object({
  status: z.nativeEnum(ApplicationStatus).optional(),
  kind: z.enum(["REQUIREMENT", "PACKAGE"]).optional(),
  tutorId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminApplicationListQuery = z.infer<typeof adminApplicationListQuerySchema>;

export const adminApplicationTargetSchema = z
  .object({
    id: z.string(),
    /** Package title; null for requirements. */
    title: z.string().nullable(),
    /** Requirement only; null for packages. */
    levelCode: z.number().nullable(),
    /** Requirement only; null for packages. */
    curriculum: z.nativeEnum(Curriculum).nullable(),
  })
  .meta({ id: "AdminApplicationTarget" });
export type AdminApplicationTarget = z.infer<typeof adminApplicationTargetSchema>;

export const adminApplicationFeeSchema = z
  .object({
    id: z.string(),
    status: z.nativeEnum(FeeStatus),
    amountDue: z.string(),
    amountPaid: z.string(),
  })
  .meta({ id: "AdminApplicationFee" });

export const adminApplicationSchema = z
  .object({
    id: z.string(),
    status: z.nativeEnum(ApplicationStatus),
    kind: z.enum(["REQUIREMENT", "PACKAGE"]),
    initiatedBy: z.nativeEnum(InitiatedBy),
    appliedAt: z.date(),
    confirmedAt: z.date().nullable(),
    endedAt: z.date().nullable(),
    tutor: z.object({ id: z.string(), name: z.string() }),
    student: z.object({ id: z.string(), name: z.string() }),
    target: adminApplicationTargetSchema,
    /** Latest non-VOID PLACEMENT fee; null when there is none. */
    fee: adminApplicationFeeSchema.nullable(),
  })
  .meta({ id: "AdminApplication" });

export type AdminApplicationResponse = z.infer<typeof adminApplicationSchema>;

export const adminApplicationPageSchema = z
  .object({
    applications: z.array(adminApplicationSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminApplicationPage" });
