import type { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { prisma } from "../../lib/prisma.js";
import { unattachedFileWhere } from "../files/files.service.js";
import type {
  AdminFileListQuery,
  AdminFileResponse,
  AdminFileStatsResponse,
} from "./files.schema.js";

// Relation counts mirror fileInUse in files/files.service.ts. Keep the two in step.
const adminFileInclude = {
  owner: { select: { email: true } },
  _count: {
    select: {
      studentVerifications: true,
      tutorVerifications: true,
      credentials: true,
      videos: true,
      blogCovers: true,
    },
  },
} as const;

type AdminFileRow = Prisma.FileAssetGetPayload<{ include: typeof adminFileInclude }>;

function toAdminFile(row: AdminFileRow): AdminFileResponse {
  const c = row._count;
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    fileName: row.originalName,
    createdAt: row.createdAt,
    uploadedAt: row.uploadedAt,
    ownerAccountId: row.ownerAccountId,
    ownerEmail: row.owner.email,
    published: row.publishedAt !== null,
    inUse:
      c.studentVerifications + c.tutorVerifications + c.credentials + c.videos + c.blogCovers > 0,
  };
}

// Newest first, keyset over (created_at, id).
export async function listAdminFiles(query: AdminFileListQuery): Promise<{
  files: AdminFileResponse[];
  nextCursor: string | null;
}> {
  const clauses: Prisma.FileAssetWhereInput[] = [];
  if (query.purpose) clauses.push({ purpose: query.purpose });
  if (query.status) clauses.push({ status: query.status });
  if (query.ownerAccountId) clauses.push({ ownerAccountId: query.ownerAccountId });
  if (query.unattached === "true") clauses.push({ ...unattachedFileWhere });
  if (query.unattached === "false") clauses.push({ NOT: { ...unattachedFileWhere } });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.fileAsset.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: adminFileInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    files: page.map(toAdminFile),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// Counts and bytes per purpose and status, over every file row.
export async function getAdminFileStats(): Promise<AdminFileStatsResponse> {
  const groups = await prisma.fileAsset.groupBy({
    by: ["purpose", "status"],
    _count: { _all: true },
    _sum: { sizeBytes: true },
    orderBy: [{ purpose: "asc" }, { status: "asc" }],
  });
  return {
    groups: groups.map((g) => ({
      purpose: g.purpose,
      status: g.status,
      count: g._count._all,
      totalBytes: g._sum.sizeBytes ?? 0,
    })),
  };
}
