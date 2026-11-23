import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AdminInvite, AdminTeamMember } from "./admins.schema.js";

export const ADMIN_INVITE_DAYS = 14;

const memberInclude = {
  account: { select: { email: true, lastLoginAt: true } },
  approvedBy: { select: { name: true } },
} satisfies Prisma.AdminUserInclude;

type AdminRow = Prisma.AdminUserGetPayload<{ include: typeof memberInclude }>;

function toMember(row: AdminRow): AdminTeamMember {
  return {
    accountId: row.accountId,
    name: row.name,
    email: row.account.email,
    adminRole: row.adminRole,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    approvedAt: row.approvedAt,
    approvedByName: row.approvedBy?.name ?? null,
    removedAt: row.removedAt,
    createdAt: row.createdAt,
    lastLoginAt: row.account.lastLoginAt,
  };
}

// AdminStatus is declared PENDING, ACTIVE, REMOVED, and Postgres sorts enums in that order.
export async function listAdminTeam(): Promise<{ admins: AdminTeamMember[] }> {
  const rows = await prisma.adminUser.findMany({
    include: memberInclude,
    orderBy: [{ status: "asc" }, { createdAt: "asc" }, { accountId: "asc" }],
    take: 200,
  });
  return { admins: rows.map(toMember) };
}

export async function approveAdmin(
  accountId: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<AdminTeamMember> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT account_id FROM admin_user WHERE account_id = ${accountId}::uuid FOR UPDATE`;
    const admin = await tx.adminUser.findUnique({
      where: { accountId },
      select: { status: true, account: { select: { status: true } } },
    });
    if (!admin) {
      throw notFound("Admin not found");
    }
    if (admin.status !== "PENDING") {
      throw appError("InvalidAdminState", 409, "Only pending admins can be approved");
    }
    if (admin.account.status !== "ACTIVE") {
      throw appError("InvalidAdminState", 409, "This account is blocked or deleted");
    }

    const updated = await tx.adminUser.update({
      where: { accountId },
      data: { status: "ACTIVE", approvedById: caller.accountId, approvedAt: new Date() },
      include: memberInclude,
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.approve",
      entityType: "admin_user",
      entityId: accountId,
      before: { status: "PENDING" },
      after: { status: "ACTIVE" },
      ip,
    });
    return toMember(updated);
  });
}

export async function removeAdmin(
  accountId: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<AdminTeamMember> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT account_id FROM admin_user WHERE account_id = ${accountId}::uuid FOR UPDATE`;
    const admin = await tx.adminUser.findUnique({
      where: { accountId },
      select: { status: true, adminRole: true },
    });
    if (!admin) {
      throw notFound("Admin not found");
    }
    if (accountId === caller.accountId) {
      throw appError("InvalidAdminState", 409, "You cannot remove yourself");
    }
    if (admin.adminRole === "SUPER_ADMIN") {
      throw appError("InvalidAdminState", 409, "A super admin cannot be removed");
    }
    if (admin.status === "REMOVED") {
      throw appError("InvalidAdminState", 409, "This admin was already removed");
    }

    const now = new Date();
    const updated = await tx.adminUser.update({
      where: { accountId },
      data: { status: "REMOVED", removedById: caller.accountId, removedAt: now },
      include: memberInclude,
    });
    await tx.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: now },
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.remove",
      entityType: "admin_user",
      entityId: accountId,
      before: { status: admin.status },
      after: { status: "REMOVED" },
      ip,
    });
    return toMember(updated);
  });
}

const inviteInclude = {
  invitedBy: { select: { name: true } },
} satisfies Prisma.AdminInviteInclude;

type InviteRow = Prisma.AdminInviteGetPayload<{ include: typeof inviteInclude }>;

function toInvite(row: InviteRow, now: Date): AdminInvite {
  return {
    id: row.id,
    email: row.email,
    invitedByName: row.invitedBy.name,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    expired: row.expiresAt <= now,
  };
}

export async function createAdminInvite(
  email: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<AdminInvite> {
  return prisma.$transaction(async (tx) => {
    // Serialises two invites for one email, so a second super admin cannot overwrite an open invite unseen.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`admin_invite:${email}`}))`;
    const now = new Date();
    if (await tx.account.findUnique({ where: { email }, select: { id: true } })) {
      throw appError("AccountExists", 409, "This email already has an account");
    }
    if (await tx.superAdminEmail.findUnique({ where: { email }, select: { slot: true } })) {
      throw appError("SuperAdminEmail", 409, "This email belongs to a super admin");
    }
    const existing = await tx.adminInvite.findUnique({
      where: { email },
      select: { expiresAt: true },
    });
    if (existing && existing.expiresAt > now) {
      throw appError("InviteExists", 409, "This email already has an open invite");
    }

    const expiresAt = new Date(now.getTime() + ADMIN_INVITE_DAYS * 24 * 60 * 60 * 1000);
    const invite = await tx.adminInvite.upsert({
      where: { email },
      create: { email, invitedById: caller.accountId, createdAt: now, expiresAt },
      update: { invitedById: caller.accountId, createdAt: now, expiresAt },
      include: inviteInclude,
    });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.invite",
      entityType: "admin_invite",
      entityId: invite.id,
      after: { email },
      ip,
    });
    return toInvite(invite, now);
  });
}

export async function listAdminInvites(): Promise<{ invites: AdminInvite[] }> {
  const now = new Date();
  const rows = await prisma.adminInvite.findMany({
    include: inviteInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  });
  return { invites: rows.map((row) => toInvite(row, now)) };
}

export async function revokeAdminInvite(
  id: string,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const invite = await tx.adminInvite.findUnique({ where: { id }, select: { email: true } });
    if (!invite) {
      throw notFound("Invite not found");
    }
    // Sign-in may accept the invite between the read and this delete; the count tells us which won.
    const { count } = await tx.adminInvite.deleteMany({ where: { id } });
    if (count === 0) {
      throw notFound("Invite not found");
    }

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "admin.invite_revoke",
      entityType: "admin_invite",
      entityId: id,
      before: { email: invite.email },
      ip,
    });
  });
}
