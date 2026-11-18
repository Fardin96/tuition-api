import type { Prisma } from "../generated/prisma/client.js";

// Ids that cannot be newly chosen: unknown or inactive. Rows that already reference an inactive area keep it.
export async function unusableAreaIds(db: Prisma.TransactionClient, ids: number[]) {
  const found = await db.area.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true },
  });
  const foundIds = new Set(found.map((row) => row.id));
  return ids.filter((id) => !foundIds.has(id));
}
