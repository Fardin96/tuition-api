import type { FastifyInstance } from "fastify";
import type { Prisma } from "../generated/prisma/client.js";

// Every response from an admin route plugin, including 401/403/404/409, is private and uncacheable.
export function privateNoStore(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    return payload;
  });
}

export type AuditEntry = {
  actorAccountId: string;
  /** "<entity>.<verb>", for example "fee.waive" or "account.block". */
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  ip?: string | null;
};

// audit_log is append-only. Write it in the same transaction as the change it records.
export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  await tx.auditLog.create({
    data: {
      actorAccountId: entry.actorAccountId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
      ip: entry.ip ?? null,
    },
  });
}
