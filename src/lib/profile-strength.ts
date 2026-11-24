import type { PrismaClient } from "../generated/prisma/client.js";

// Thresholds and weights live in the SQL functions tutor_profile_items / student_profile_items.
export const COMPLETE_AT = { TUTOR: 60, STUDENT: 60 } as const;
export const BADGE_AT = { TUTOR: 85, STUDENT: 80 } as const;

export const PROFILE_ITEM_KEYS = [
  "basics",
  "phone_verified",
  "photo",
  "institute",
  "subjects",
  "location_pin",
  "default_set",
  "id_verified",
  "credential",
  "video",
  "whatsapp",
] as const;

export type ProfileItem = { key: string; weight: number; done: boolean };
type Role = "TUTOR" | "STUDENT";
type Db = Pick<PrismaClient, "$queryRaw">;

// Both must be done for the badge: a verified ID and phone, not just a high percent.
// The web copy names these two items too (phone and ID), so keep them in step.
const BADGE_REQUIRED = ["id_verified", "phone_verified"];

export function summarizeStrength(role: Role, items: ProfileItem[]) {
  const percent = items.reduce((sum, i) => sum + (i.done ? i.weight : 0), 0);
  const verified = BADGE_REQUIRED.every((key) => items.some((i) => i.key === key && i.done));
  return {
    percent,
    complete: percent >= COMPLETE_AT[role],
    completeAt: COMPLETE_AT[role],
    verifiedBadge: percent >= BADGE_AT[role] && verified,
    badgeAt: BADGE_AT[role],
    items,
  };
}

export async function loadProfileItems(db: Db, role: Role, profileId: string) {
  const rows =
    role === "TUTOR"
      ? await db.$queryRaw<
          ProfileItem[]
        >`SELECT key, weight, done FROM tutor_profile_items(${profileId}::uuid)`
      : await db.$queryRaw<
          ProfileItem[]
        >`SELECT key, weight, done FROM student_profile_items(${profileId}::uuid)`;
  return rows.map((r) => ({ key: r.key, weight: Number(r.weight), done: r.done }));
}

type ItemRow = { id: string; key: string; weight: number; done: boolean };

// Badges for many profiles in one query per chunk. Ids with no profile rows get false.
async function badgesFor(db: Db, role: Role, ids: string[]): Promise<Map<string, boolean>> {
  const badges = new Map<string, boolean>();
  // Unpaged tutor search is capped at UNPAGED_SEARCH_MAX rows, so this is at most a few chunks.
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const rows =
      role === "TUTOR"
        ? await db.$queryRaw<ItemRow[]>`
            SELECT x.id, i.key, i.weight, i.done
            FROM unnest(${chunk}::uuid[]) AS x(id)
            CROSS JOIN LATERAL tutor_profile_items(x.id) AS i`
        : await db.$queryRaw<ItemRow[]>`
            SELECT x.id, i.key, i.weight, i.done
            FROM unnest(${chunk}::uuid[]) AS x(id)
            CROSS JOIN LATERAL student_profile_items(x.id) AS i`;
    const byId = new Map<string, ProfileItem[]>();
    for (const r of rows) {
      const items = byId.get(r.id) ?? [];
      items.push({ key: r.key, weight: Number(r.weight), done: r.done });
      byId.set(r.id, items);
    }
    for (const id of chunk) {
      badges.set(id, summarizeStrength(role, byId.get(id) ?? []).verifiedBadge);
    }
  }
  return badges;
}

export const tutorBadges = (db: Db, tutorIds: string[]) => badgesFor(db, "TUTOR", tutorIds);
export const studentBadges = (db: Db, studentIds: string[]) => badgesFor(db, "STUDENT", studentIds);
