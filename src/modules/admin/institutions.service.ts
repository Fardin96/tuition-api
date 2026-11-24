import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminInstitution,
  CreateInstitutionInput,
  InstitutionListQuery,
  UpdateInstitutionInput,
} from "./institutions.schema.js";

const institutionSelect = {
  id: true,
  name: true,
  kind: true,
  district: true,
  area: true,
  eiin: true,
  aliases: true,
  isActive: true,
  popularity: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { tutors: true, requirements: true } },
} satisfies Prisma.InstitutionSelect;

type InstitutionRow = Prisma.InstitutionGetPayload<{ select: typeof institutionSelect }>;

function toAdminInstitution(row: InstitutionRow): AdminInstitution {
  const { _count, createdAt, updatedAt, ...rest } = row;
  return {
    ...rest,
    tutorCount: _count.tutors,
    requirementCount: _count.requirements,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function institutionExists() {
  return appError("InstitutionExists", 409, "This school or university is already on the list.");
}

// Two admins can pass a check at once; the unique indexes reject the second write.
function rethrowUniqueViolation(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw institutionExists();
  }
  throw error;
}

// Aliases are kept once each, first spelling wins, compared case-insensitively.
function dedupeAliases(aliases: string[]) {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    const key = alias.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listInstitutions(query: InstitutionListQuery) {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.q) {
    conditions.push(Prisma.sql`(
      i.search_text LIKE '%' || institution_norm(${query.q}) || '%'
      OR institution_norm(${query.q}) = ANY(i.alias_keys)
      OR i.eiin = ${query.q})`);
  }
  if (query.kind) conditions.push(Prisma.sql`i.kind = ${query.kind}::"InstitutionKind"`);
  if (query.status !== "all") {
    conditions.push(Prisma.sql`i.is_active = ${query.status === "active"}`);
  }
  const where = Prisma.join(conditions, " AND ");

  const [counted, ids] = await Promise.all([
    prisma.$queryRaw<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM institution i WHERE ${where}`,
    prisma.$queryRaw<{ id: number }[]>`
      SELECT i.id FROM institution i WHERE ${where}
      ORDER BY i.name, i.id OFFSET ${query.offset} LIMIT ${query.limit}`,
  ]);
  const rows = await prisma.institution.findMany({
    where: { id: { in: ids.map((row) => row.id) } },
    select: institutionSelect,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return { institutions: rows.map(toAdminInstitution), total: counted[0]?.count ?? 0 };
}

export async function createInstitution(
  input: CreateInstitutionInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminInstitution> {
  const data = {
    name: input.name,
    kind: input.kind,
    district: input.district ?? null,
    area: input.area ?? null,
    aliases: dedupeAliases(input.aliases ?? []),
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.institution.create({ data, select: institutionSelect });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "institution.create",
        entityType: "institution",
        entityId: String(row.id),
        after: {
          name: row.name,
          kind: row.kind,
          district: row.district,
          area: row.area,
          aliases: row.aliases,
        },
        ip: ip ?? null,
      });
      return toAdminInstitution(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}

export async function updateInstitution(
  id: number,
  input: UpdateInstitutionInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminInstitution> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the row so two edits to the same institution run one after the other.
      await tx.$queryRaw`SELECT id FROM institution WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.institution.findUnique({
        where: { id },
        select: institutionSelect,
      });
      if (!existing) throw notFound("Institution not found");

      const data: Prisma.InstitutionUpdateInput = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.district !== undefined ? { district: input.district } : {}),
        ...(input.area !== undefined ? { area: input.area } : {}),
        ...(input.aliases !== undefined ? { aliases: dedupeAliases(input.aliases) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      };
      const before = Object.fromEntries(
        Object.keys(data).map((field) => [field, existing[field as keyof typeof existing]]),
      ) as Prisma.InputJsonObject;

      const row = await tx.institution.update({ where: { id }, data, select: institutionSelect });
      // Linked rows show the canonical name, so a rename reaches them in the same transaction.
      if (input.name !== undefined && input.name !== existing.name) {
        await tx.tutor.updateMany({
          where: { institutionId: id },
          data: { instituteName: row.name },
        });
        await tx.tuitionRequirement.updateMany({
          where: { institutionId: id },
          data: { instituteName: row.name },
        });
      }
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "institution.update",
        entityType: "institution",
        entityId: String(id),
        before,
        after: data as Prisma.InputJsonObject,
        ip: ip ?? null,
      });
      return toAdminInstitution(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}
