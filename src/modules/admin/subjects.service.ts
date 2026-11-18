import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AdminSubject, CreateSubjectInput, UpdateSubjectInput } from "./subjects.schema.js";

const subjectSelect = {
  id: true,
  name: true,
  slug: true,
  sortOrder: true,
  isActive: true,
  _count: { select: { tutorSubjects: true } },
} satisfies Prisma.SubjectSelect;

type SubjectRow = Prisma.SubjectGetPayload<{ select: typeof subjectSelect }>;

function toAdminSubject(row: SubjectRow): AdminSubject {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    tutorCount: row._count.tutorSubjects,
  };
}

// Lowercase, runs of non-alphanumerics become one dash, no leading or trailing dash.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subjectExists() {
  return appError("SubjectExists", 409, "A subject with this name or slug already exists");
}

// Name is compared case-insensitively; the slug is exact (it is already lowercase).
async function assertNameAndSlugFree(
  tx: Prisma.TransactionClient,
  values: { name: string; slug: string },
  exceptId?: number,
) {
  const clash = await tx.subject.findFirst({
    where: {
      id: exceptId === undefined ? undefined : { not: exceptId },
      OR: [{ name: { equals: values.name, mode: "insensitive" } }, { slug: values.slug }],
    },
    select: { id: true },
  });
  if (clash) throw subjectExists();
}

// Two admins can pass the check at once; the unique indexes then reject the second write.
function rethrowUniqueViolation(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw subjectExists();
  }
  throw error;
}

export async function listAdminSubjects(): Promise<AdminSubject[]> {
  const rows = await prisma.subject.findMany({
    select: subjectSelect,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toAdminSubject);
}

export async function createSubject(
  input: CreateSubjectInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminSubject> {
  const slug = input.slug ?? slugify(input.name);
  if (slug.length < 2) {
    throw validationIssuesError("Invalid subject slug", [
      { path: "slug", message: "Name must produce a slug of at least 2 characters" },
    ]);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await assertNameAndSlugFree(tx, { name: input.name, slug });
      const row = await tx.subject.create({
        data: { name: input.name, slug, sortOrder: input.sortOrder },
        select: subjectSelect,
      });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "subject.create",
        entityType: "subject",
        entityId: String(row.id),
        after: { name: row.name, slug: row.slug, sortOrder: row.sortOrder, isActive: row.isActive },
        ip: ip ?? null,
      });
      return toAdminSubject(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}

export async function updateSubject(
  id: number,
  input: UpdateSubjectInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminSubject> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the row so two edits to the same subject run one after the other.
      await tx.$queryRaw`SELECT id FROM subject WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.subject.findUnique({ where: { id }, select: subjectSelect });
      if (!existing) throw notFound("Subject not found");

      const next = {
        name: input.name ?? existing.name,
        slug: input.slug ?? existing.slug,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        isActive: input.isActive ?? existing.isActive,
      };
      if (next.name !== existing.name || next.slug !== existing.slug) {
        await assertNameAndSlugFree(tx, { name: next.name, slug: next.slug }, id);
      }

      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (field) => next[field] !== existing[field],
      );
      if (changed.length === 0) return toAdminSubject(existing);

      const data = Object.fromEntries(changed.map((field) => [field, next[field]])) as Partial<
        typeof next
      >;
      const before = Object.fromEntries(
        changed.map((field) => [field, existing[field]]),
      ) as Prisma.InputJsonObject;
      const after = data as Prisma.InputJsonObject;

      const row = await tx.subject.update({ where: { id }, data, select: subjectSelect });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "subject.update",
        entityType: "subject",
        entityId: String(id),
        before,
        after,
        ip: ip ?? null,
      });
      return toAdminSubject(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}
