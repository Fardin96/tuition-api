import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { AccountStatus, CaseStatus, Role } from "../../generated/prisma/enums.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError } from "../../lib/errors.js";

// Shared by admin reports and disputes: the queue sort, the cursor and the action state machine.

export const OPEN_STATUSES = ["OPEN", "UNDER_REVIEW"] as const;
export const CLOSED_STATUSES = ["RESOLVED", "DISMISSED"] as const;

export const caseQueueSchema = z.enum(["open", "closed"]).default("open");
export type CaseQueue = z.infer<typeof caseQueueSchema>;

export const caseIdParamSchema = z.object({ id: z.string().uuid() });
export type CaseIdParam = z.infer<typeof caseIdParamSchema>;

export const caseActionSchema = z
  .object({
    action: z.enum(["ASSIGN", "RESOLVE", "DISMISS"]),
    note: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action !== "ASSIGN" && v.note === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Add a note that says how the case was closed",
      });
    }
  })
  .meta({ id: "CaseAction" });
export type CaseActionInput = z.infer<typeof caseActionSchema>;

// A user as the moderator sees them. name comes from the tutor, student or admin profile.
export const adminPartySchema = z
  .object({
    accountId: z.string(),
    role: z.nativeEnum(Role),
    status: z.nativeEnum(AccountStatus),
    name: z.string().nullable(),
    email: z.string(),
  })
  .meta({ id: "AdminParty" });
export type AdminParty = z.infer<typeof adminPartySchema>;

export const adminHandlerSchema = z
  .object({ accountId: z.string(), name: z.string().nullable() })
  .meta({ id: "AdminCaseHandler" });

export const caseStatusSchema = z.nativeEnum(CaseStatus);

export const partyInclude = {
  select: {
    id: true,
    role: true,
    status: true,
    email: true,
    tutor: { select: { name: true } },
    student: { select: { name: true } },
    adminUser: { select: { name: true } },
  },
} satisfies { select: Prisma.AccountSelect };

type PartySource = Prisma.AccountGetPayload<typeof partyInclude>;

export function toAdminParty(account: PartySource): AdminParty {
  return {
    accountId: account.id,
    role: account.role,
    status: account.status,
    name: account.tutor?.name ?? account.student?.name ?? account.adminUser?.name ?? null,
    email: account.email,
  };
}

export const handlerInclude = { select: { accountId: true, name: true } } as const;

export function toHandler(
  handler: { accountId: string; name: string } | null,
): { accountId: string; name: string | null } | null {
  return handler ? { accountId: handler.accountId, name: handler.name } : null;
}

// open: the work queue, oldest first. closed: history, newest first. The cursor follows the sort.
export function caseQueuePage(queue: CaseQueue, cursorRaw: string | undefined) {
  const open = queue === "open";
  const statuses: CaseStatus[] = [...(open ? OPEN_STATUSES : CLOSED_STATUSES)];
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  const after = cursor
    ? open
      ? [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ]
      : [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ]
    : undefined;
  const order: Prisma.SortOrder = open ? "asc" : "desc";
  return {
    where: { status: { in: statuses }, ...(after ? { OR: after } : {}) },
    orderBy: [{ createdAt: order }, { id: order }],
  };
}

export function sliceCasePage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export type CaseChange = {
  verb: "assign" | "resolve" | "dismiss";
  data: {
    status: CaseStatus;
    handledById: string;
    resolvedAt?: Date;
    resolutionNote?: string;
  };
};

// The state machine. ASSIGN takes an OPEN case, or an UNDER_REVIEW one held by someone else.
// RESOLVE and DISMISS close an OPEN or UNDER_REVIEW case and need a note.
export function planCaseChange(
  current: { status: CaseStatus; handledById: string | null },
  input: CaseActionInput,
  adminId: string,
): CaseChange {
  if (current.status === "RESOLVED" || current.status === "DISMISSED") {
    throw appError("InvalidCaseState", 409, "This case is already closed.");
  }
  if (input.action === "ASSIGN") {
    if (current.status === "UNDER_REVIEW" && current.handledById === adminId) {
      throw appError("InvalidCaseState", 409, "This case is already assigned to you.");
    }
    return { verb: "assign", data: { status: "UNDER_REVIEW", handledById: adminId } };
  }
  const resolve = input.action === "RESOLVE";
  return {
    verb: resolve ? "resolve" : "dismiss",
    data: {
      status: resolve ? "RESOLVED" : "DISMISSED",
      handledById: adminId,
      resolvedAt: new Date(),
      resolutionNote: input.note,
    },
  };
}
