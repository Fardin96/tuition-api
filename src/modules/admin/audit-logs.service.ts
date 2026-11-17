import type { Prisma } from "../../generated/prisma/client.js";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuditLogEntry, AuditLogListQuery } from "./audit-logs.schema.js";

const BIGINT_MAX = 9223372036854775807n;

const auditLogSelect = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  before: true,
  after: true,
  ip: true,
  createdAt: true,
  actor: {
    select: {
      id: true,
      email: true,
      adminUser: { select: { name: true } },
      tutor: { select: { name: true } },
      student: { select: { name: true } },
    },
  },
} satisfies Prisma.AuditLogSelect;

type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof auditLogSelect }>;

// The cursor is the last id as a decimal string, base64url-encoded. Clients pass it back unchanged.
function encodeCursor(id: bigint): string {
  return Buffer.from(id.toString(10)).toString("base64url");
}

function decodeCursor(raw: string): bigint {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!/^\d{1,19}$/.test(text) || BigInt(text) > BIGINT_MAX) {
    throw appError("ValidationError", 400, "Invalid cursor");
  }
  return BigInt(text);
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  const actor = row.actor;
  return {
    id: String(row.id),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    ip: row.ip,
    createdAt: row.createdAt,
    actor: actor
      ? {
          accountId: actor.id,
          email: actor.email,
          name: actor.adminUser?.name ?? actor.tutor?.name ?? actor.student?.name ?? null,
        }
      : null,
  };
}

// Newest first. Keyset on id, so a page never shifts under concurrent writes.
export async function listAuditLogs(query: AuditLogListQuery) {
  const where: Prisma.AuditLogWhereInput = {};
  if (query.entityType) where.entityType = query.entityType;
  if (query.entityId) where.entityId = query.entityId;
  if (query.actorAccountId) where.actorAccountId = query.actorAccountId;
  if (query.action) where.action = query.action;
  if (query.cursor) where.id = { lt: decodeCursor(query.cursor) };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: query.limit + 1,
    select: auditLogSelect,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    entries: page.map(toEntry),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}
