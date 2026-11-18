import { Prisma } from "../../generated/prisma/client.js";
import { PromoRedemptionStatus } from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminPromoCodeDetailResponse,
  AdminPromoCodeResponse,
  CreatePromoCodeInput,
  PromoCodeListQuery,
  UpdatePromoCodeInput,
} from "./promo-codes.schema.js";

// Keep in step with the promo_code columns. The list and detail reads share the same shape.
const promoCodeSelect = {
  id: true,
  code: true,
  description: true,
  discountType: true,
  discountValue: true,
  maxDiscount: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  maxPerTutor: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { name: true, account: { select: { email: true } } } },
  _count: { select: { redemptions: { where: { status: PromoRedemptionStatus.ACTIVE } } } },
} satisfies Prisma.PromoCodeSelect;

const promoDetailSelect = {
  ...promoCodeSelect,
  redemptions: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      feeId: true,
      originalAmount: true,
      discountAmount: true,
      status: true,
      createdAt: true,
      releasedAt: true,
      releaseReason: true,
      tutor: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PromoCodeSelect;

// The stored terms only, for the audit log and for reading a row before a change.
const promoTermsSelect = {
  id: true,
  code: true,
  description: true,
  discountType: true,
  discountValue: true,
  maxDiscount: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  maxPerTutor: true,
  isActive: true,
} satisfies Prisma.PromoCodeSelect;

type PromoCodeRow = Prisma.PromoCodeGetPayload<{ select: typeof promoCodeSelect }>;
type PromoDetailRow = Prisma.PromoCodeGetPayload<{ select: typeof promoDetailSelect }>;
type PromoTermsRow = Prisma.PromoCodeGetPayload<{ select: typeof promoTermsSelect }>;

function toAdminPromoCode(row: PromoCodeRow): AdminPromoCodeResponse {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    discountType: row.discountType,
    discountValue: row.discountValue.toFixed(2),
    maxDiscount: row.maxDiscount?.toFixed(2) ?? null,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    maxRedemptions: row.maxRedemptions,
    maxPerTutor: row.maxPerTutor,
    isActive: row.isActive,
    redemptionCount: row._count.redemptions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByName: row.createdBy.name.trim() || row.createdBy.account.email,
  };
}

function toAdminPromoCodeDetail(row: PromoDetailRow): AdminPromoCodeDetailResponse {
  return {
    ...toAdminPromoCode(row),
    redemptions: row.redemptions.map((r) => ({
      id: r.id,
      feeId: r.feeId,
      tutor: { id: r.tutor.id, name: r.tutor.name },
      originalAmount: r.originalAmount.toFixed(2),
      discountAmount: r.discountAmount.toFixed(2),
      status: r.status,
      createdAt: r.createdAt,
      releasedAt: r.releasedAt,
      releaseReason: r.releaseReason,
    })),
  };
}

function termsJson(row: PromoTermsRow): Prisma.InputJsonObject {
  return {
    code: row.code,
    description: row.description,
    discountType: row.discountType,
    discountValue: row.discountValue.toFixed(2),
    maxDiscount: row.maxDiscount?.toFixed(2) ?? null,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    maxRedemptions: row.maxRedemptions,
    maxPerTutor: row.maxPerTutor,
    isActive: row.isActive,
  };
}

// Reads the detail view inside whichever client the caller is using (the singleton or a transaction).
async function readDetail(
  db: Pick<Prisma.TransactionClient, "promoCode">,
  id: string,
): Promise<AdminPromoCodeDetailResponse> {
  const row = await db.promoCode.findUnique({ where: { id }, select: promoDetailSelect });
  if (!row) throw notFound("Promo code not found");
  return toAdminPromoCodeDetail(row);
}

function promoCodeExists() {
  return appError("PromoCodeExists", 409, "A promo code with that name already exists.");
}

export async function listPromoCodes(query: PromoCodeListQuery): Promise<{
  promoCodes: AdminPromoCodeResponse[];
  nextCursor: string | null;
}> {
  const clauses: Prisma.PromoCodeWhereInput[] = [];
  if (query.active === "true") clauses.push({ isActive: true });
  if (query.active === "false") clauses.push({ isActive: false });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.promoCode.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: promoCodeSelect,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    promoCodes: page.map(toAdminPromoCode),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getPromoCode(id: string): Promise<AdminPromoCodeDetailResponse> {
  return readDetail(prisma, id);
}

export async function createPromoCode(
  input: CreatePromoCodeInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminPromoCodeDetailResponse> {
  const code = input.code.toUpperCase();
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.promoCode.create({
        data: {
          code,
          description: input.description ?? null,
          discountType: input.discountType,
          discountValue: new Prisma.Decimal(input.discountValue.toFixed(2)),
          maxDiscount:
            input.maxDiscount === undefined
              ? null
              : new Prisma.Decimal(input.maxDiscount.toFixed(2)),
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          maxRedemptions: input.maxRedemptions ?? null,
          maxPerTutor: input.maxPerTutor,
          createdById: admin.accountId,
        },
        select: promoTermsSelect,
      });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "promo.create",
        entityType: "promo_code",
        entityId: row.id,
        after: termsJson(row),
        ip: ip ?? null,
      });
      return readDetail(tx, row.id);
    });
  } catch (error) {
    // Unique on code. The stored code is uppercase, so this also catches a case-only difference.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw promoCodeExists();
    }
    throw error;
  }
}

// Discount terms are not editable. endsAt has to be in the future and after the stored startsAt.
export async function updatePromoCode(
  id: string,
  input: UpdatePromoCodeInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminPromoCodeDetailResponse> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.promoCode.findUnique({ where: { id }, select: promoTermsSelect });
    if (!existing) throw notFound("Promo code not found");

    if (input.endsAt) {
      const endsAt = new Date(input.endsAt);
      if (endsAt.getTime() <= Date.now()) {
        throw validationIssuesError("Invalid promo code", [
          { path: "endsAt", message: "The end must be in the future" },
        ]);
      }
      if (existing.startsAt && endsAt.getTime() <= existing.startsAt.getTime()) {
        throw validationIssuesError("Invalid promo code", [
          { path: "endsAt", message: "The end must be after the start" },
        ]);
      }
    }

    const current = {
      description: existing.description,
      endsAt: existing.endsAt?.toISOString() ?? null,
      maxRedemptions: existing.maxRedemptions,
      maxPerTutor: existing.maxPerTutor,
      isActive: existing.isActive,
    };
    const next = {
      description: input.description === undefined ? current.description : input.description,
      endsAt:
        input.endsAt === undefined
          ? current.endsAt
          : input.endsAt === null
            ? null
            : new Date(input.endsAt).toISOString(),
      maxRedemptions:
        input.maxRedemptions === undefined ? current.maxRedemptions : input.maxRedemptions,
      maxPerTutor: input.maxPerTutor ?? current.maxPerTutor,
      isActive: input.isActive ?? current.isActive,
    };

    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (field) => next[field] !== current[field],
    );
    if (changed.length === 0) return readDetail(tx, id);

    const data: Prisma.PromoCodeUpdateInput = {};
    if (changed.includes("description")) data.description = next.description;
    if (changed.includes("endsAt")) {
      data.endsAt = next.endsAt === null ? null : new Date(next.endsAt);
    }
    if (changed.includes("maxRedemptions")) data.maxRedemptions = next.maxRedemptions;
    if (changed.includes("maxPerTutor")) data.maxPerTutor = next.maxPerTutor;
    if (changed.includes("isActive")) data.isActive = next.isActive;

    const before = Object.fromEntries(
      changed.map((field) => [field, current[field]]),
    ) as Prisma.InputJsonObject;
    const after = Object.fromEntries(
      changed.map((field) => [field, next[field]]),
    ) as Prisma.InputJsonObject;

    await tx.promoCode.update({ where: { id }, data });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "promo.update",
      entityType: "promo_code",
      entityId: id,
      before,
      after,
      ip: ip ?? null,
    });
    return readDetail(tx, id);
  });
}
