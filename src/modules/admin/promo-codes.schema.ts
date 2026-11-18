import { z } from "zod";
import { PromoDiscountType, PromoRedemptionStatus } from "../../generated/prisma/enums.js";

// Same money rule as fee amounts: positive, at most 2 decimals, at most FLAT_MAX.
const FLAT_MAX = 5_000_000;

const moneySchema = z
  .number()
  .positive()
  .max(FLAT_MAX)
  .refine((n) => Math.round(n * 100) / 100 === n, {
    message: "Amount can have at most 2 decimal places",
  });

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/;

const descriptionSchema = z.string().trim().min(1).max(200);
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const promoCodeIdParamSchema = z.object({ id: z.string().uuid() });
export type PromoCodeIdParam = z.infer<typeof promoCodeIdParamSchema>;

export const adminPromoRedemptionSchema = z
  .object({
    id: z.string(),
    feeId: z.string(),
    tutor: z.object({ id: z.string(), name: z.string() }),
    originalAmount: z.string(),
    discountAmount: z.string(),
    status: z.nativeEnum(PromoRedemptionStatus),
    createdAt: z.date(),
    releasedAt: z.date().nullable(),
    releaseReason: z.string().nullable(),
  })
  .meta({ id: "AdminPromoRedemption" });

export const adminPromoCodeSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    discountType: z.nativeEnum(PromoDiscountType),
    /** 2-dp string: a percent (0 to 100] or a taka amount. */
    discountValue: z.string(),
    /** 2-dp string, or null. A cap on PERCENT codes only. */
    maxDiscount: z.string().nullable(),
    startsAt: z.date().nullable(),
    endsAt: z.date().nullable(),
    /** Across all tutors. null = no limit. */
    maxRedemptions: z.number().int().nullable(),
    maxPerTutor: z.number().int(),
    isActive: z.boolean(),
    /** ACTIVE redemptions only. RELEASED ones (code removed, fee voided) do not count. */
    redemptionCount: z.number().int(),
    createdAt: z.date(),
    updatedAt: z.date(),
    /** The creating admin's name, or their account email when the name is blank. */
    createdByName: z.string(),
  })
  .meta({ id: "AdminPromoCode" });
export type AdminPromoCodeResponse = z.infer<typeof adminPromoCodeSchema>;

// Latest 50 redemptions, newest first.
export const adminPromoCodeDetailSchema = adminPromoCodeSchema
  .extend({ redemptions: z.array(adminPromoRedemptionSchema) })
  .meta({ id: "AdminPromoCodeDetail" });
export type AdminPromoCodeDetailResponse = z.infer<typeof adminPromoCodeDetailSchema>;

export const adminPromoCodePageSchema = z
  .object({
    promoCodes: z.array(adminPromoCodeSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminPromoCodePage" });

export const promoCodeListQuerySchema = z.object({
  active: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PromoCodeListQuery = z.infer<typeof promoCodeListQuerySchema>;

export const createPromoCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(
        CODE_PATTERN,
        "Use 3 to 32 letters, digits, dashes or underscores, starting with a letter or digit",
      ),
    description: descriptionSchema.optional(),
    discountType: z.nativeEnum(PromoDiscountType),
    discountValue: moneySchema,
    maxDiscount: moneySchema.optional(),
    startsAt: isoDateTimeSchema.optional(),
    endsAt: isoDateTimeSchema.optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
    maxPerTutor: z.number().int().min(1).max(100).default(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.discountType === "PERCENT" && v.discountValue > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["discountValue"],
        message: "A percent discount can be at most 100",
      });
    }
    if (v.discountType === "FLAT" && v.maxDiscount !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDiscount"],
        message: "A maximum discount applies to percent codes only",
      });
    }
    if (v.startsAt !== undefined && v.endsAt !== undefined) {
      if (new Date(v.endsAt).getTime() <= new Date(v.startsAt).getTime()) {
        ctx.addIssue({
          code: "custom",
          path: ["endsAt"],
          message: "The end must be after the start",
        });
      }
    }
    if (v.endsAt !== undefined && new Date(v.endsAt).getTime() <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end must be in the future",
      });
    }
  })
  .meta({ id: "CreatePromoCode" });
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

// Discount terms are immutable. endsAt null clears the end; the future and "after startsAt"
// checks need the stored row, so the service runs them. At least one field must be sent.
export const updatePromoCodeSchema = z
  .object({
    description: descriptionSchema.nullable().optional(),
    endsAt: isoDateTimeSchema.nullable().optional(),
    maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
    maxPerTutor: z.number().int().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdatePromoCode" });
export type UpdatePromoCodeInput = z.infer<typeof updatePromoCodeSchema>;
