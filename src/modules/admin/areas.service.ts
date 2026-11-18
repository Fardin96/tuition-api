import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { DISTRICTS, toDistrictCode } from "../../lib/districts.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminArea,
  AdminAreaDistrict,
  AdminAreaList,
  AdminAreaListQuery,
  CreateAreaInput,
  UpdateAreaInput,
} from "./areas.schema.js";

const areaSelect = {
  id: true,
  division: true,
  district: true,
  name: true,
  isActive: true,
  _count: { select: { students: true, tutorAreas: true, requirements: true } },
} satisfies Prisma.AreaSelect;

type AreaRow = Prisma.AreaGetPayload<{ select: typeof areaSelect }>;

function toAdminArea(row: AreaRow): AdminArea {
  return {
    id: row.id,
    name: row.name,
    division: row.division,
    district: row.district,
    districtCode: toDistrictCode(row.district),
    isActive: row.isActive,
    tutorCount: row._count.tutorAreas,
    studentCount: row._count.students,
    requirementCount: row._count.requirements,
  };
}

// Every district in DISTRICTS, sorted by division then name. Constant, so built once.
const adminAreaDistricts: AdminAreaDistrict[] = Object.entries(DISTRICTS)
  .map(([code, { name, division }]) => ({ code, name, division }))
  .sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));

function areaExists() {
  return appError("AreaExists", 409, "An area with this name already exists in this district");
}

// Name is compared case-insensitively, inside one district.
async function assertNameFreeInDistrict(
  tx: Prisma.TransactionClient,
  values: { district: string; name: string },
  exceptId?: number,
) {
  const clash = await tx.area.findFirst({
    where: {
      id: exceptId === undefined ? undefined : { not: exceptId },
      district: { equals: values.district, mode: "insensitive" },
      name: { equals: values.name, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (clash) throw areaExists();
}

// Two admins can pass the check at once; the unique index then rejects the second write.
function rethrowUniqueViolation(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw areaExists();
  }
  throw error;
}

export async function listAdminAreas(query: AdminAreaListQuery): Promise<AdminAreaList> {
  const where: Prisma.AreaWhereInput = {};
  if (query.districtCode) {
    where.district = { equals: DISTRICTS[query.districtCode].name, mode: "insensitive" };
  }
  if (query.q) where.name = { contains: query.q, mode: "insensitive" };
  if (query.isActive !== undefined) where.isActive = query.isActive === "true";

  const rows = await prisma.area.findMany({
    where,
    select: areaSelect,
    orderBy: [{ division: "asc" }, { district: "asc" }, { name: "asc" }],
  });
  return { areas: rows.map(toAdminArea), districts: adminAreaDistricts };
}

export async function createArea(
  input: CreateAreaInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminArea> {
  const { name: district, division } = DISTRICTS[input.districtCode];

  try {
    return await prisma.$transaction(async (tx) => {
      await assertNameFreeInDistrict(tx, { district, name: input.name });
      const row = await tx.area.create({
        data: { division, district, name: input.name },
        select: areaSelect,
      });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "area.create",
        entityType: "area",
        entityId: String(row.id),
        after: {
          name: row.name,
          division: row.division,
          district: row.district,
          isActive: row.isActive,
        },
        ip: ip ?? null,
      });
      return toAdminArea(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}

export async function updateArea(
  id: number,
  input: UpdateAreaInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminArea> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the row so two edits to the same area run one after the other.
      await tx.$queryRaw`SELECT id FROM area WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.area.findUnique({ where: { id }, select: areaSelect });
      if (!existing) throw notFound("Area not found");

      const next = {
        name: input.name ?? existing.name,
        isActive: input.isActive ?? existing.isActive,
      };
      if (next.name !== existing.name) {
        await assertNameFreeInDistrict(tx, { district: existing.district, name: next.name }, id);
      }

      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (field) => next[field] !== existing[field],
      );
      if (changed.length === 0) return toAdminArea(existing);

      const data = Object.fromEntries(changed.map((field) => [field, next[field]])) as Partial<
        typeof next
      >;
      const before = Object.fromEntries(
        changed.map((field) => [field, existing[field]]),
      ) as Prisma.InputJsonObject;
      const after = data as Prisma.InputJsonObject;

      const row = await tx.area.update({ where: { id }, data, select: areaSelect });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "area.update",
        entityType: "area",
        entityId: String(id),
        before,
        after,
        ip: ip ?? null,
      });
      return toAdminArea(row);
    });
  } catch (error) {
    return rethrowUniqueViolation(error);
  }
}
