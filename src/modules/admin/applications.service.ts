import type { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminApplicationListQuery,
  AdminApplicationResponse,
  AdminApplicationTarget,
} from "./applications.schema.js";

const applicationInclude = {
  tutor: { select: { id: true, name: true } },
  student: { select: { id: true, name: true } },
  requirement: { select: { id: true, levelCode: true, curriculum: true } },
  package: { select: { id: true, title: true } },
  fees: {
    where: { feeType: "PLACEMENT", status: { not: "VOID" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, status: true, amountDue: true, amountPaid: true },
  },
} satisfies Prisma.ApplicationInclude;

type ApplicationRow = Prisma.ApplicationGetPayload<{ include: typeof applicationInclude }>;

// An application points at exactly one listing (CHECK application_has_target).
function targetOf(row: ApplicationRow): {
  kind: "REQUIREMENT" | "PACKAGE";
  target: AdminApplicationTarget;
} {
  if (row.package) {
    return {
      kind: "PACKAGE",
      target: { id: row.package.id, title: row.package.title, levelCode: null, curriculum: null },
    };
  }
  if (row.requirement) {
    return {
      kind: "REQUIREMENT",
      target: {
        id: row.requirement.id,
        title: null,
        levelCode: row.requirement.levelCode,
        curriculum: row.requirement.curriculum,
      },
    };
  }
  throw new Error(`application ${row.id} has no target`);
}

function toAdminApplication(row: ApplicationRow): AdminApplicationResponse {
  const { kind, target } = targetOf(row);
  const fee = row.fees[0];
  return {
    id: row.id,
    status: row.status,
    kind,
    initiatedBy: row.initiatedBy,
    appliedAt: row.appliedAt,
    confirmedAt: row.confirmedAt,
    endedAt: row.endedAt,
    tutor: { id: row.tutor.id, name: row.tutor.name },
    student: { id: row.student.id, name: row.student.name },
    target,
    fee: fee
      ? {
          id: fee.id,
          status: fee.status,
          amountDue: fee.amountDue.toFixed(2),
          amountPaid: fee.amountPaid.toFixed(2),
        }
      : null,
  };
}

// Read-only work list, newest first. Keyset over (appliedAt desc, id desc).
export async function listAdminApplications(query: AdminApplicationListQuery): Promise<{
  applications: AdminApplicationResponse[];
  nextCursor: string | null;
}> {
  const clauses: Prisma.ApplicationWhereInput[] = [];

  if (query.status) clauses.push({ status: query.status });
  if (query.kind === "PACKAGE") clauses.push({ packageId: { not: null } });
  if (query.kind === "REQUIREMENT") clauses.push({ requirementId: { not: null } });
  if (query.tutorId) clauses.push({ tutorId: query.tutorId });
  if (query.studentId) clauses.push({ studentId: query.studentId });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { appliedAt: { lt: cursor.createdAt } },
        { appliedAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.application.findMany({
    where: { AND: clauses },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: applicationInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    applications: page.map(toAdminApplication),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.appliedAt, id: last.id }) : null,
  };
}
