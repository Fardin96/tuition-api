import { Prisma } from "../../generated/prisma/client.js";
import { validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

// Kinds ranked first for each reader: a tutor usually names a university or college.
const PREFERRED_KINDS = {
  tutor: ["UNIVERSITY", "COLLEGE"],
  student: ["SCHOOL", "SCHOOL_AND_COLLEGE", "COLLEGE"],
} as const;

// Tier: 0 exact alias, 1 exact name or initials, 2 name or alias prefix, 3 contains, 4 every typed word
// present, 5 the rest. Popularity only ranks inside tiers 0-3, so a weak match never beats a popular one.
// shortcut: the OR and NOT EXISTS make this a sequential scan (~3 ms on 1.3k rows); split into indexable UNION branches if the table grows past ~20k rows.
export async function searchInstitutions(
  q: string,
  forRole: keyof typeof PREFERRED_KINDS | undefined,
  limit: number,
) {
  const preferredKinds: string[] = forRole ? [...PREFERRED_KINDS[forRole]] : [];
  return prisma.$queryRaw<
    {
      id: number;
      name: string;
      kind: string;
      district: string | null;
      area: string | null;
      matchedAlias: string | null;
    }[]
  >(Prisma.sql`
    WITH q AS (SELECT institution_norm(${q}) AS n, lower(btrim(${q})) AS raw)
    SELECT i.id, i.name, i.kind, i.district, i.area,
      CASE WHEN q.n = ANY(i.alias_keys)
           THEN (SELECT a FROM unnest(i.aliases) AS a WHERE institution_norm(a) = q.n
                 ORDER BY lower(a) = q.raw DESC LIMIT 1) END AS "matchedAlias"
    FROM institution i, q
    CROSS JOIN LATERAL (
      -- Folding merges short names (AUW and AUB, SSMC and ShSMC), so the alias typed letter for letter wins.
      SELECT EXISTS (SELECT 1 FROM unnest(i.aliases) a WHERE lower(a) = q.raw) AS exact,
      CASE
        WHEN q.n = ANY(i.alias_keys) THEN 0
        WHEN i.name_key = q.n OR (char_length(q.n) >= 3 AND i.initials_key = q.n) THEN 1
        WHEN i.name_key LIKE q.n || '%' OR EXISTS (SELECT 1 FROM unnest(i.alias_keys) k WHERE k LIKE q.n || '%') THEN 2
        WHEN i.search_text LIKE '%' || q.n || '%' THEN 3
        WHEN NOT EXISTS (SELECT 1 FROM unnest(string_to_array(q.n, ' ')) AS t(w) WHERE i.search_text NOT LIKE '%' || t.w || '%') THEN 4
        ELSE 5 END AS tier) t
    WHERE i.is_active AND q.n <> '' AND (
      q.n = ANY(i.alias_keys)
      OR i.search_text LIKE '%' || q.n || '%'
      OR NOT EXISTS (SELECT 1 FROM unnest(string_to_array(q.n, ' ')) AS t(w) WHERE i.search_text NOT LIKE '%' || t.w || '%')
      OR (char_length(q.n) >= 3 AND i.initials_key = q.n)
      OR (char_length(q.n) >= 3 AND word_similarity(q.n, i.search_text) >= 0.4))
    ORDER BY t.exact DESC, t.tier,
      CASE WHEN i.kind = ANY(${preferredKinds}::"InstitutionKind"[]) THEN 0 ELSE 1 END,
      CASE WHEN t.tier <= 3 THEN i.popularity ELSE 0 END DESC,
      word_similarity(q.n, i.search_text) DESC, i.popularity DESC, i.name, i.id
    LIMIT ${limit}
  `);
}

// Resolves a picked id. A new pick must be active; the row already linked may be hidden since.
export async function resolveInstitution(
  db: Prisma.TransactionClient,
  id: number,
  currentId: number | null = null,
) {
  const row = await db.institution.findFirst({
    where: { id, ...(id === currentId ? {} : { isActive: true }) },
    select: { id: true, name: true },
  });
  if (!row) {
    throw validationIssuesError("Invalid institution", [
      { path: "institutionId", message: "Pick a school or university from the list." },
    ]);
  }
  return row;
}

// Typed text links only when exactly one active row has that name; otherwise it is saved unlinked.
async function linkByName(db: Prisma.TransactionClient, text: string) {
  const matches = await db.$queryRaw<{ id: number; name: string }[]>`
    SELECT id, name FROM institution
    WHERE is_active AND name_key = institution_norm(${text})
    LIMIT 2`;
  if (matches.length === 1 && matches[0]) {
    return { institutionId: matches[0].id, instituteName: matches[0].name };
  }
  return { institutionId: null, instituteName: text };
}

// The institute columns a tutor or requirement write sets. `currentId` is the row's link now (null on create).
// A new pick saves its canonical name; the linked row keeps its link and text when no text is sent; null
// unlinks and keeps the text sent (null clears it); typed text links when it exactly names one active row,
// else it is saved unlinked; neither touches the row.
export async function instituteFields(
  db: Prisma.TransactionClient,
  input: { institutionId?: number | null; instituteName?: string | null },
  currentId: number | null,
): Promise<{ institutionId?: number | null; instituteName?: string | null }> {
  if (typeof input.institutionId === "number") {
    if (input.institutionId === currentId && input.instituteName === undefined) return {};
    const institution = await resolveInstitution(db, input.institutionId, currentId);
    return { institutionId: institution.id, instituteName: institution.name };
  }
  if (input.instituteName === undefined) {
    return input.institutionId === null ? { institutionId: null } : {};
  }
  if (input.instituteName === null) return { institutionId: null, instituteName: null };
  return linkByName(db, input.instituteName);
}
