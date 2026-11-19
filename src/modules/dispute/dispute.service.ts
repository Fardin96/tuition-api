import { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type {
  CreateDisputeInput,
  MyDisputeListQuery,
  MyDisputePageResponse,
  MyDisputeResponse,
} from "./dispute.schema.js";

const APPLICATION_NOT_FOUND = "Application not found";
const NOT_ALLOWED = "Only a confirmed or completed tuition can be disputed.";
const ALREADY_OPEN = "You already have an open dispute on this tuition.";
// The one-open-dispute-per-raiser index. Any unique violation on insert can only come from it.
const ONE_OPEN_INDEX = "dispute_one_open_per_raiser";

const disputeInclude = {
  against: {
    select: {
      id: true,
      role: true,
      student: { select: { name: true } },
      tutor: { select: { name: true } },
    },
  },
} as const;

type DisputeRow = Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>;

function toMyDispute(row: DisputeRow): MyDisputeResponse {
  const closed = row.status === "RESOLVED" || row.status === "DISMISSED";
  return {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: closed ? row.resolutionNote : null,
    against: {
      accountId: row.against.id,
      role: row.against.role,
      name: row.against.tutor?.name ?? row.against.student?.name ?? null,
    },
  };
}

// The two parties of an application, or a 404 when the caller is not one of them.
async function otherParty(applicationId: string, caller: AuthContext) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      status: true,
      tutor: { select: { accountId: true } },
      student: { select: { accountId: true } },
    },
  });
  if (!application) throw notFound(APPLICATION_NOT_FOUND);
  const tutorAccount = application.tutor.accountId;
  const studentAccount = application.student.accountId;
  if (caller.accountId !== tutorAccount && caller.accountId !== studentAccount) {
    throw notFound(APPLICATION_NOT_FOUND);
  }
  return {
    status: application.status,
    againstId: caller.accountId === tutorAccount ? studentAccount : tutorAccount,
  };
}

function isOpenDisputeConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  const text = err instanceof Error ? err.message : "";
  return text.includes(ONE_OPEN_INDEX) || text.includes("unique_violation");
}

// dispute_guard raises when the match is no longer confirmed or completed (a race with a cancel).
function isGuardViolation(err: unknown): boolean {
  const text = err instanceof Error ? err.message : "";
  return text.includes("only a confirmed or completed match can be disputed");
}

export async function createDispute(
  caller: AuthContext,
  input: CreateDisputeInput,
): Promise<MyDisputeResponse> {
  const { status, againstId } = await otherParty(input.applicationId, caller);
  if (status !== "CONFIRMED" && status !== "COMPLETED") {
    throw appError("DisputeNotAllowed", 409, NOT_ALLOWED);
  }

  const open = await prisma.dispute.findFirst({
    where: {
      applicationId: input.applicationId,
      raisedById: caller.accountId,
      status: { in: ["OPEN", "UNDER_REVIEW"] },
    },
    select: { id: true },
  });
  if (open) throw appError("DisputeExists", 409, ALREADY_OPEN);

  try {
    const row = await prisma.dispute.create({
      data: {
        applicationId: input.applicationId,
        raisedById: caller.accountId,
        againstId,
        type: input.type,
        details: input.details,
      },
      include: disputeInclude,
    });
    return toMyDispute(row);
  } catch (err) {
    if (isOpenDisputeConflict(err)) throw appError("DisputeExists", 409, ALREADY_OPEN);
    if (isGuardViolation(err)) throw appError("DisputeNotAllowed", 409, NOT_ALLOWED);
    throw err;
  }
}

export async function listMyDisputes(
  caller: AuthContext,
  query: MyDisputeListQuery,
): Promise<MyDisputePageResponse> {
  const where: Prisma.DisputeWhereInput = { raisedById: caller.accountId };
  if (query.applicationId) {
    // A caller who is not a party gets 404 rather than an empty list.
    await otherParty(query.applicationId, caller);
    where.applicationId = query.applicationId;
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.dispute.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: disputeInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    disputes: page.map(toMyDispute),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
