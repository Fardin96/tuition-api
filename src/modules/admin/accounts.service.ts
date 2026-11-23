import type { Prisma } from "../../generated/prisma/client.js";
import type { AdminRole } from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { hardDeleteAccount, softDeleteInTx } from "../auth/auth.service.js";
import { removeAccountFromLanding } from "../site-content/site-content.service.js";
import type {
  AccountActionReasonInput,
  AccountListQuery,
  AdminAccountDetail,
  AdminAccountSummary,
  BlockAccountInput,
} from "./accounts.schema.js";

const summaryInclude = {
  student: { select: { name: true, phoneNumber: true, phoneVerifiedAt: true } },
  tutor: { select: { name: true, phoneNumber: true, phoneVerifiedAt: true } },
  adminUser: { select: { name: true } },
} satisfies Prisma.AccountInclude;

type SummarySource = Prisma.AccountGetPayload<{ include: typeof summaryInclude }>;

const detailInclude = {
  student: {
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      phoneVerifiedAt: true,
      whatsappNumber: true,
      verificationStatus: true,
    },
  },
  tutor: {
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      phoneVerifiedAt: true,
      whatsappNumber: true,
      verificationStatus: true,
      isListed: true,
      instituteName: true,
    },
  },
  adminUser: { select: { name: true, adminRole: true, status: true } },
  blocks: {
    orderBy: [{ blockedAt: "desc" }, { id: "desc" }],
    take: 20,
    include: {
      blockedBy: { select: { name: true } },
      unblockedBy: { select: { name: true } },
    },
  },
} satisfies Prisma.AccountInclude;

type DetailRow = Prisma.AccountGetPayload<{ include: typeof detailInclude }>;

// A "deleted:" value is the tombstone a soft-deleted account leaves in place of its number.
function contactValue(value: string | null | undefined): string | null {
  if (!value || value.startsWith("deleted:")) return null;
  return value;
}

// Null without a profile or a usable number, so a tombstoned number never reads as verified.
function phoneVerifiedAt(row: SummarySource): Date | null {
  const profile = row.student ?? row.tutor;
  if (!profile || contactValue(profile.phoneNumber) === null) return null;
  return profile.phoneVerifiedAt;
}

function toSummary(row: SummarySource): AdminAccountSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    name: row.student?.name ?? row.tutor?.name ?? row.adminUser?.name ?? null,
    phoneNumber: contactValue(row.student?.phoneNumber ?? row.tutor?.phoneNumber),
    phoneVerifiedAt: phoneVerifiedAt(row),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    deletedAt: row.deletedAt,
  };
}

// Newest first. Keyset pagination over (created_at, id).
export async function listAccounts(query: AccountListQuery) {
  const and: Prisma.AccountWhereInput[] = [];
  if (query.q) {
    const q = query.q;
    and.push({
      OR: [
        { email: { contains: q, mode: "insensitive" } },
        {
          student: {
            is: {
              OR: [{ name: { contains: q, mode: "insensitive" } }, { phoneNumber: q }],
            },
          },
        },
        {
          tutor: {
            is: {
              OR: [{ name: { contains: q, mode: "insensitive" } }, { phoneNumber: q }],
            },
          },
        },
        { adminUser: { is: { name: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    and.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.account.findMany({
    where: { role: query.role, status: query.status, AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: summaryInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    accounts: page.map(toSummary),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getAccountDetail(accountId: string): Promise<AdminAccountDetail> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    include: detailInclude,
  });
  if (!row) {
    throw notFound("Account not found");
  }
  return buildDetail(row);
}

async function buildDetail(row: DetailRow): Promise<AdminAccountDetail> {
  const studentId = row.student?.id ?? null;
  const tutorId = row.tutor?.id ?? null;

  const partyFilters: Prisma.ApplicationWhereInput[] = [];
  if (tutorId) partyFilters.push({ tutorId });
  if (studentId) partyFilters.push({ studentId });
  const applications =
    partyFilters.length > 0 ? await prisma.application.count({ where: { OR: partyFilters } }) : 0;
  const openRequirements = studentId
    ? await prisma.tuitionRequirement.count({ where: { studentId, status: "OPEN" } })
    : 0;
  const openPackages = tutorId
    ? await prisma.tuitionPackage.count({ where: { tutorId, status: "OPEN" } })
    : 0;

  const activeBlock = await prisma.accountBlock.findFirst({
    where: { accountId: row.id, unblockedAt: null },
    include: { blockedBy: { select: { name: true } } },
  });

  return {
    ...toSummary(row),
    consentVersion: row.consentVersion,
    consentAcceptedAt: row.consentAcceptedAt,
    studentId,
    tutorId,
    whatsappNumber: contactValue(row.student?.whatsappNumber ?? row.tutor?.whatsappNumber),
    verificationStatus: row.student?.verificationStatus ?? row.tutor?.verificationStatus ?? null,
    isListed: row.tutor?.isListed ?? null,
    instituteName: row.tutor?.instituteName ?? null,
    adminRole: row.adminUser?.adminRole ?? null,
    adminStatus: row.adminUser?.status ?? null,
    activeBlock: activeBlock
      ? {
          id: activeBlock.id,
          reason: activeBlock.reason,
          blockedAt: activeBlock.blockedAt,
          blockedByName: activeBlock.blockedBy.name,
        }
      : null,
    blocks: row.blocks.map((block) => ({
      id: block.id,
      reason: block.reason,
      blockedAt: block.blockedAt,
      blockedByName: block.blockedBy.name,
      unblockedAt: block.unblockedAt,
      unblockedByName: block.unblockedBy?.name ?? null,
    })),
    counts: { applications, openRequirements, openPackages },
  };
}

/** The admin acting: any ACTIVE admin (requireAdmin). */
type Caller = { accountId: string; adminRole: AdminRole };

/** Admin accounts are for super admins only: a plain admin may act on students and tutors. */
function assertMayActOnAdmin(target: { role: string }, caller: Caller, verb: string) {
  if (target.role === "ADMIN" && caller.adminRole !== "SUPER_ADMIN") {
    throw appError("Forbidden", 403, `Only a super admin can ${verb} an admin account`);
  }
}

export async function blockAccount(
  accountId: string,
  input: BlockAccountInput,
  caller: Caller,
  ip: string | undefined,
): Promise<AdminAccountDetail> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { role: true, status: true, adminUser: { select: { adminRole: true } } },
    });
    if (!account) {
      throw notFound("Account not found");
    }
    if (accountId === caller.accountId) {
      throw appError("InvalidAccountState", 409, "You cannot block yourself");
    }
    if (account.adminUser?.adminRole === "SUPER_ADMIN") {
      throw appError("InvalidAccountState", 409, "A super admin cannot be blocked");
    }
    assertMayActOnAdmin(account, caller, "block");
    if (account.status === "DELETED") {
      throw appError("InvalidAccountState", 409, "Deleted accounts cannot be blocked");
    }
    const openBlock = await tx.accountBlock.findFirst({
      where: { accountId, unblockedAt: null },
      select: { id: true },
    });
    if (account.status === "BLOCKED" || openBlock) {
      throw appError("InvalidAccountState", 409, "This account is already blocked");
    }

    // The account_block trigger sets account.status and the tutor listing.
    await tx.accountBlock.create({
      data: { accountId, blockedById: caller.accountId, reason: input.reason },
    });
    await tx.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // A blocked account's stories and videos leave the landing page.
    await removeAccountFromLanding(tx, accountId, caller.accountId);

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "account.block",
      entityType: "account",
      entityId: accountId,
      after: { reason: input.reason },
      ip,
    });
  });
  return getAccountDetail(accountId);
}

export async function unblockAccount(
  accountId: string,
  caller: Caller,
  ip: string | undefined,
): Promise<AdminAccountDetail> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { role: true, status: true },
    });
    if (!account) {
      throw notFound("Account not found");
    }
    assertMayActOnAdmin(account, caller, "unblock");
    const openBlock = await tx.accountBlock.findFirst({
      where: { accountId, unblockedAt: null },
      select: { id: true },
    });
    if (!openBlock) {
      throw appError("InvalidAccountState", 409, "This account is not blocked");
    }

    await tx.accountBlock.update({
      where: { id: openBlock.id },
      data: { unblockedAt: new Date(), unblockedById: caller.accountId },
    });
    // Read back the status: a DELETED account stays DELETED after its block lifts.
    const updated = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { status: true },
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "account.unblock",
      entityType: "account",
      entityId: accountId,
      before: { status: account.status },
      after: { status: updated.status },
      ip,
    });
  });
  return getAccountDetail(accountId);
}

const contactSelect = { id: true, phoneNumber: true, whatsappNumber: true } as const;

/**
 * Locks the account row and refuses the caller themselves and every super admin; an admin account
 * only a super admin may touch. Used by deactivate and permanent delete.
 */
async function lockRemovableAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  caller: Caller,
  action: { verb: string; past: string },
) {
  await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: {
      role: true,
      status: true,
      adminUser: { select: { adminRole: true } },
      student: { select: contactSelect },
      tutor: { select: contactSelect },
    },
  });
  if (!account) {
    throw notFound("Account not found");
  }
  if (accountId === caller.accountId) {
    throw appError("InvalidAccountState", 409, `You cannot ${action.verb} yourself`);
  }
  if (account.adminUser?.adminRole === "SUPER_ADMIN") {
    throw appError("InvalidAccountState", 409, `A super admin cannot be ${action.past}`);
  }
  assertMayActOnAdmin(account, caller, action.verb);
  return account;
}

/**
 * The soft delete, done by an admin ("Deactivate" in the admin panel). A blocked account must
 * be unblocked first: the database keeps BLOCKED in step with account_block and refuses to change it.
 */
export async function deactivateAccount(
  accountId: string,
  input: AccountActionReasonInput,
  caller: Caller,
  ip: string | undefined,
): Promise<AdminAccountDetail> {
  await prisma.$transaction(async (tx) => {
    const account = await lockRemovableAccount(tx, accountId, caller, {
      verb: "deactivate",
      past: "deactivated",
    });
    if (account.status === "DELETED") {
      throw appError("InvalidAccountState", 409, "This account is already deactivated");
    }
    if (account.status === "BLOCKED") {
      throw appError("InvalidAccountState", 409, "Unblock this account before deactivating it");
    }
    await softDeleteInTx(tx, accountId, account, caller.accountId);
    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "account.deactivate",
      entityType: "account",
      entityId: accountId,
      before: { status: account.status },
      after: { status: "DELETED", reason: input.reason },
      ip,
    });
  });
  return getAccountDetail(accountId);
}

// Postgres refuses the delete when kept records still point at the account (RESTRICT keys).
function isForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "P2003" || code === "23503") return true;
  return typeof message === "string" && /foreign key constraint/i.test(message);
}

/**
 * Permanently deletes an account (the same delete as DELETE /me/hard-delete) for an admin.
 * The audit row is written in the same transaction, without the account's email or name. Payment
 * records and an admin's audit history are kept, so such an account answers 409: block or
 * deactivate it.
 */
export async function hardDeleteAccountAsAdmin(
  accountId: string,
  input: AccountActionReasonInput,
  caller: Caller,
  ip: string | undefined,
): Promise<void> {
  try {
    await hardDeleteAccount(accountId, {
      beforeDelete: async (tx) => {
        const account = await lockRemovableAccount(tx, accountId, caller, {
          verb: "delete",
          past: "deleted",
        });
        await writeAudit(tx, {
          actorAccountId: caller.accountId,
          action: "account.delete",
          entityType: "account",
          entityId: accountId,
          before: { role: account.role, status: account.status },
          after: { reason: input.reason },
          ip,
        });
      },
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw appError(
        "InvalidAccountState",
        409,
        "This account has payment or admin records that must be kept, so it can't be deleted. Block or deactivate it instead.",
      );
    }
    throw err;
  }
}
