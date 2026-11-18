import { z } from "zod";
import { RefundStatus } from "../../generated/prisma/enums.js";
import { adminRefundSchema } from "../refunds/refund.schema.js";

// Notes and reasons: 3 to 500 characters once trimmed.
const text = z.string().trim().min(3).max(500);
// Same shape the gateway wrapper accepts for refund references (SAFE_ID in sslcommerz.ts).
const refundRefId = /^[\w.-]{1,64}$/;

// Money in: a positive amount with at most 2 decimals, for example "500" or "1250.50".
const isPositiveMoney = (value: string) =>
  /^\d{1,10}(\.\d{1,2})?$/.test(value) && Number(value) > 0;

export const adminRefundPageSchema = z
  .object({
    refunds: z.array(adminRefundSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminRefundPage" });

export const refundIdParamSchema = z.object({ id: z.string().uuid() });
export type RefundIdParam = z.infer<typeof refundIdParamSchema>;

// tran_id: our reference, letters and digits, at most 30 characters.
export const createRefundSchema = z
  .object({
    tranId: z.string().regex(/^[A-Za-z0-9]{1,30}$/),
    amount: z
      .string()
      .refine(isPositiveMoney, {
        message: "amount must be a positive amount with up to 2 decimals",
      })
      .optional(),
    reason: text,
  })
  .strict()
  .meta({ id: "CreateRefund" });
export type CreateRefundBody = z.infer<typeof createRefundSchema>;

export const approveRefundSchema = z
  .object({ note: text.optional() })
  .strict()
  .meta({ id: "ApproveRefund" });
export type ApproveRefundBody = z.infer<typeof approveRefundSchema>;

export const rejectRefundSchema = z.object({ note: text }).strict().meta({ id: "RejectRefund" });
export type RejectRefundBody = z.infer<typeof rejectRefundSchema>;

export const resolveRefundSchema = z
  .object({
    outcome: z.enum(["SUCCEEDED", "FAILED"]),
    refundRefId: z.string().regex(refundRefId).optional(),
    note: text,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.refundRefId !== undefined && value.outcome !== "SUCCEEDED") {
      ctx.addIssue({
        code: "custom",
        path: ["refundRefId"],
        message: "A gateway reference is only recorded when the refund succeeded.",
      });
    }
  })
  .meta({ id: "ResolveRefund" });
export type ResolveRefundBody = z.infer<typeof resolveRefundSchema>;

export const refundListQuerySchema = z.object({
  status: z.nativeEnum(RefundStatus).optional(),
  // true: REQUESTED, PROCESSING or NEEDS_REVIEW. false: every other status.
  open: z.enum(["true", "false"]).optional(),
  feeId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type RefundListQuery = z.infer<typeof refundListQuerySchema>;
