import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { appError, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fileUrl, publishFile } from "../files/files.service.js";
import defaults from "./defaults.json" with { type: "json" };
import type {
  AdminSiteContentItem,
  AdminSiteSource,
  CardSource,
  LandingSourceKind,
  PageSlug,
  SiteContentResponse,
  SitePageResponse,
} from "./site-content.schema.js";
import {
  BLOCK_SCHEMAS,
  type BlockValue,
  fileRefId,
  LANDING_KEYS,
  MEDIA_FIELD_KINDS,
  MEDIA_PURPOSES,
  type MediaPurpose,
  PAGE_SLUGS,
  SITE_CONTENT_KEYS,
  type SiteContentKey,
} from "./site-content.schema.js";

// Reads are lenient: a stored row that no longer fits its schema shows the default instead.
// Writes are strict: the value is parsed in full before anything is saved.
//
// Lock order for anything that touches both: the source rows (story, tutor_video) first, then the
// site_content rows (testimonials, showcase), then the file rows. Every path below follows it.

// The two lists that can hold cards made from user submissions.
const CARD_KEYS = ["testimonials", "showcase"] as const;
type CardKey = (typeof CARD_KEYS)[number];

function defaultFor<K extends SiteContentKey>(key: K): BlockValue<K> {
  return (defaults as Record<SiteContentKey, unknown>)[key] as BlockValue<K>;
}

function readBlock<K extends SiteContentKey>(key: K, raw: unknown): BlockValue<K> {
  const parsed = (BLOCK_SCHEMAS[key] as unknown as z.ZodType<BlockValue<K>>).safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`site content: stored value for "${key}" is invalid, showing the default`);
  return defaultFor(key);
}

function conflict() {
  return appError(
    "SiteContentConflict",
    409,
    "Someone else changed this block. Reload to see their version.",
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function sourceKey(source: CardSource): string {
  return `${source.kind}:${source.id}`;
}

// ── Uploaded media ─────────────────────────────────────────────

type MediaKind = (typeof MEDIA_FIELD_KINDS)[keyof typeof MEDIA_FIELD_KINDS];
type FileRef = { path: (string | number)[]; fileId: string; kind: MediaKind };

/** Every "file:<id>" value under a media field name in a block, with where it sits. */
export function collectFileRefs(value: unknown, path: (string | number)[] = []): FileRef[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectFileRefs(item, [...path, index]));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (typeof child === "string" && Object.hasOwn(MEDIA_FIELD_KINDS, key)) {
      const fileId = fileRefId(child);
      const kind = MEDIA_FIELD_KINDS[key as keyof typeof MEDIA_FIELD_KINDS];
      return fileId ? [{ path: [...path, key], fileId, kind }] : [];
    }
    return collectFileRefs(child, [...path, key]);
  });
}

/** Which purposes each media kind takes. Story and tutor video files only inside their own card. */
const ACCEPTED_PURPOSES: Record<MediaKind, readonly string[]> = {
  image: ["SITE_IMAGE", "STORY_IMAGE"],
  video: ["SITE_VIDEO", "STORY_VIDEO", "TUTOR_VIDEO"],
};
const OWNED_PURPOSES: ReadonlySet<string> = new Set(["STORY_IMAGE", "STORY_VIDEO", "TUTOR_VIDEO"]);

/** Replaces the value at a path inside a block copy. */
function setAt(root: unknown, path: (string | number)[], value: string): void {
  let node = root as Record<string | number, unknown>;
  const last = path.length - 1;
  for (let i = 0; i < last; i++) node = node[path[i]] as Record<string | number, unknown>;
  node[path[last]] = value;
}

const mediaFileSelect = {
  id: true,
  storageKey: true,
  status: true,
  publishedAt: true,
  originalName: true,
  contentType: true,
  purpose: true,
} as const;

type MediaFile = Prisma.FileAssetGetPayload<{ select: typeof mediaFileSelect }>;
type AdminMedia = AdminSiteContentItem["media"];
type AdminMediaEntry = AdminMedia[string];

/** The file rows behind every "file:<id>" in the given blocks, in one query. */
async function mediaFilesFor(
  db: Prisma.TransactionClient | typeof prisma,
  values: unknown[],
): Promise<Map<string, MediaFile>> {
  const ids = [
    ...new Set(values.flatMap((value) => collectFileRefs(value).map((ref) => ref.fileId))),
  ];
  if (ids.length === 0) return new Map();
  // Only media purposes: a stored ref to any other file (an ID, a certificate) is treated as
  // missing, so it can never be served from the landing page.
  const rows = await db.fileAsset.findMany({
    where: { id: { in: ids }, purpose: { in: [...MEDIA_PURPOSES] } },
    select: mediaFileSelect,
  });
  return new Map(rows.map((row) => [row.id, row] as const));
}

/**
 * The block with each uploaded file replaced by its URL (public when published, else signed).
 * A block with a file it cannot serve (missing, not uploaded, or no URL) answers its default.
 */
async function serveBlock<K extends SiteContentKey>(
  key: K,
  value: BlockValue<K>,
  files: Map<string, MediaFile>,
): Promise<BlockValue<K>> {
  const refs = collectFileRefs(value);
  if (refs.length === 0) return value;
  const served: unknown = structuredClone(value);
  for (const ref of refs) {
    const row = files.get(ref.fileId);
    const url = row ? await fileUrl(row) : null;
    if (!url) {
      console.warn(`site content: "${key}" uses a file that cannot be served, showing the default`);
      return defaultFor(key);
    }
    setAt(served, ref.path, url);
  }
  return served as BlockValue<K>;
}

/** The admin's media map for one block: the files its refs point at, keyed by file id. */
function mediaOf(all: Record<string, AdminMediaEntry>, value: unknown): AdminMedia {
  const media: AdminMedia = {};
  for (const ref of collectFileRefs(value)) {
    const entry = all[ref.fileId];
    if (entry) media[ref.fileId] = entry;
  }
  return media;
}

// ── Card sources ───────────────────────────────────────────────

/** A user submission a card points at, as read under its lock. */
type SourceInfo = {
  kind: LandingSourceKind;
  role: string;
  approved: boolean;
  accountActive: boolean;
  /** Tutor videos only: the tutor agreed to show it on the home page. */
  consented: boolean;
  /** The uploaded files that belong to the submission. */
  fileIds: string[];
};

/** Each card in a card list that has a source, with its index in the list. */
function itemSources(
  key: SiteContentKey,
  value: unknown,
): { index: number; source: CardSource; item: { kind?: string } }[] {
  if (key !== "testimonials" && key !== "showcase") return [];
  const items = (value as { items?: { kind?: string; source?: CardSource }[] }).items ?? [];
  return items.flatMap((item, index) =>
    item.source ? [{ index, source: item.source, item }] : [],
  );
}

/**
 * Locks the submissions the cards point at, FOR SHARE, and reads them: story rows first, then tutor
 * video rows, each ordered by id. A later admin decision on the same submission waits for the save.
 */
async function lockCardSources(
  tx: Prisma.TransactionClient,
  sources: CardSource[],
): Promise<Map<string, SourceInfo>> {
  const infos = new Map<string, SourceInfo>();
  const storyIds = [...new Set(sources.filter((s) => s.kind === "story").map((s) => s.id))].sort();
  const videoIds = [
    ...new Set(sources.filter((s) => s.kind === "tutor_video").map((s) => s.id)),
  ].sort();

  if (storyIds.length > 0) {
    const rows = await tx.$queryRaw<
      {
        id: string;
        role: string;
        status: string;
        active: boolean;
        image_file_id: string | null;
        video_file_id: string | null;
      }[]
    >`
      SELECT s.id::text AS id, s.role::text AS role, s.status::text AS status,
             (a.status = 'ACTIVE') AS active,
             s.image_file_id::text AS image_file_id, s.video_file_id::text AS video_file_id
      FROM story s
      JOIN account a ON a.id = s.account_id
      WHERE s.id = ANY(${storyIds}::uuid[])
      ORDER BY s.id
      FOR SHARE OF s`;
    for (const row of rows) {
      infos.set(`story:${row.id}`, {
        kind: "story",
        role: row.role,
        approved: row.status === "APPROVED",
        accountActive: row.active,
        consented: true,
        fileIds: [row.image_file_id, row.video_file_id].filter((id): id is string => id !== null),
      });
    }
  }

  if (videoIds.length > 0) {
    const rows = await tx.$queryRaw<
      { id: string; status: string; consented: boolean; active: boolean; file_id: string }[]
    >`
      SELECT v.id::text AS id, v.status::text AS status,
             (v.landing_consent_at IS NOT NULL) AS consented,
             (a.status = 'ACTIVE') AS active,
             v.file_id::text AS file_id
      FROM tutor_video v
      JOIN tutor t ON t.id = v.tutor_id
      JOIN account a ON a.id = t.account_id
      WHERE v.id = ANY(${videoIds}::uuid[])
      ORDER BY v.id
      FOR SHARE OF v`;
    for (const row of rows) {
      infos.set(`tutor_video:${row.id}`, {
        kind: "tutor_video",
        role: "TUTOR",
        approved: row.status === "APPROVED",
        accountActive: row.active,
        consented: row.consented,
        fileIds: [row.file_id],
      });
    }
  }
  return infos;
}

/** Why a card's source cannot go on the list, as validation issues under value.items.<i>.source. */
function sourceIssues(
  key: SiteContentKey,
  value: unknown,
  infos: Map<string, SourceInfo>,
): { path: string; message: string }[] {
  return itemSources(key, value).flatMap(({ index, source, item }) => {
    const path = `value.items.${index}.source`;
    const info = infos.get(sourceKey(source));
    if (!info) return [{ path, message: "This submission no longer exists. Pick another one." }];
    if (!info.approved) {
      return [{ path, message: "Only an approved submission can be shown on the landing page." }];
    }
    if (!info.accountActive) return [{ path, message: "The author's account is not active." }];

    const isComment = key === "showcase" && item.kind === "comment";
    const isVideo = key === "showcase" && item.kind === "video";
    if (isVideo && info.kind !== "tutor_video") {
      return [{ path, message: "Pick a tutor's video for a video card." }];
    }
    if (!isVideo && info.kind !== "story") {
      return [
        {
          path,
          message: isComment
            ? "Pick a tutor's story for a comment card."
            : "Only a student's story can be a testimonial.",
        },
      ];
    }
    if (info.kind === "story") {
      const wanted = isComment ? "TUTOR" : "STUDENT";
      if (info.role !== wanted) {
        return [
          {
            path,
            message: isComment
              ? "Only a tutor's story can be a comment card."
              : "Only a student's story can be a testimonial.",
          },
        ];
      }
    }
    if (info.kind === "tutor_video" && !info.consented) {
      return [{ path, message: "The tutor has not agreed to show this video on the home page." }];
    }
    return [];
  });
}

// ── Lock and remove ────────────────────────────────────────────

/**
 * Takes a card out of both lists after its submission was withdrawn, rejected or removed. The caller
 * already holds the lock on the source row. Locks the two lists, drops every card that points at the
 * source, and writes the result. A list left empty is deleted, so it shows its default again.
 */
export async function removeSourceFromLanding(
  tx: Prisma.TransactionClient,
  source: CardSource,
  actorAccountId: string | null,
): Promise<void> {
  await tx.$queryRaw`SELECT key FROM site_content WHERE key IN ('testimonials', 'showcase') ORDER BY key FOR UPDATE`;
  const rows = await tx.siteContent.findMany({
    where: { key: { in: [...CARD_KEYS] } },
    select: { key: true, value: true },
  });
  const wanted = sourceKey(source);

  for (const row of rows) {
    const key = row.key as CardKey;
    const previous = readBlock(key, row.value) as { items: { source?: CardSource }[] };
    const items = previous.items.filter(
      (item) => !item.source || sourceKey(item.source) !== wanted,
    );
    if (items.length === previous.items.length) continue;

    const next = { ...previous, items };
    if (items.length === 0) {
      // The join rows go with the row (ON DELETE CASCADE).
      await tx.siteContent.delete({ where: { key } });
    } else {
      await tx.siteContent.update({
        where: { key },
        data: { value: next as Prisma.InputJsonValue },
      });
      await replaceSiteFiles(tx, key, [...new Set(collectFileRefs(next).map((ref) => ref.fileId))]);
    }

    await writeAudit(tx, {
      actorAccountId,
      action: "site_content.source_removed",
      entityType: "site_content",
      entityId: key,
      before: { value: previous as Prisma.InputJsonValue },
      after: { value: (items.length === 0 ? defaultFor(key) : next) as Prisma.InputJsonValue },
      ip: null,
    });
  }
}

/**
 * Takes every card made from an account's stories and tutor videos off the landing page. Used when
 * the account is blocked, soft deleted or hard deleted. All source rows are locked before any list
 * is touched, so the order matches a save.
 */
export async function removeAccountFromLanding(
  tx: Prisma.TransactionClient,
  accountId: string,
  actorAccountId: string | null,
): Promise<void> {
  const stories = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM story WHERE account_id = ${accountId}::uuid ORDER BY id FOR UPDATE`;
  const tutor = await tx.tutor.findUnique({ where: { accountId }, select: { id: true } });
  const videos = tutor
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM tutor_video WHERE tutor_id = ${tutor.id}::uuid ORDER BY id FOR UPDATE`
    : [];

  const sources: CardSource[] = [
    ...stories.map((row) => ({ kind: "story" as const, id: row.id })),
    ...videos.map((row) => ({ kind: "tutor_video" as const, id: row.id })),
  ];
  for (const source of sources) {
    await removeSourceFromLanding(tx, source, actorAccountId);
  }
}

/** Keys ("story:<id>", "tutor_video:<id>") of every submission a landing card points at now. */
export async function landingSourceKeys(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Set<string>> {
  const rows = await db.siteContent.findMany({
    where: { key: { in: [...CARD_KEYS] } },
    select: { key: true, value: true },
  });
  const keys = new Set<string>();
  for (const row of rows) {
    const block = readBlock(row.key as CardKey, row.value) as { items: { source?: CardSource }[] };
    for (const item of block.items) {
      if (item.source) keys.add(sourceKey(item.source));
    }
  }
  return keys;
}

// ── Admin items ────────────────────────────────────────────────

const adminRowSelect = {
  key: true,
  value: true,
  updatedAt: true,
  updatedBy: { select: { name: true } },
} as const;

type AdminRow = Prisma.SiteContentGetPayload<{ select: typeof adminRowSelect }>;

function toAdminItem(
  key: SiteContentKey,
  row: AdminRow | null,
  value: unknown,
  media: AdminMedia,
): AdminSiteContentItem {
  return {
    key,
    value,
    defaultValue: defaultFor(key),
    media,
    isDefault: row === null,
    updatedAt: row?.updatedAt ?? null,
    updatedByName: row?.updatedBy?.name ?? null,
  };
}

/** Admin items for blocks, with the media of all of them loaded in one query. */
async function toAdminItems(
  db: Prisma.TransactionClient | typeof prisma,
  entries: { key: SiteContentKey; row: AdminRow | null }[],
): Promise<AdminSiteContentItem[]> {
  const values = entries.map(({ key, row }) => (row ? readBlock(key, row.value) : defaultFor(key)));
  const files = await mediaFilesFor(db, values);
  const all: Record<string, AdminMediaEntry> = {};
  for (const file of files.values()) {
    all[file.id] = {
      url: await fileUrl(file),
      contentType: file.contentType,
      originalName: file.originalName,
      // Only media purposes are loaded (mediaFilesFor and the source queries filter on them).
      purpose: file.purpose as MediaPurpose,
    };
  }
  return entries.map(({ key, row }, index) => {
    const value = values[index];
    return toAdminItem(key, row, value, mediaOf(all, value));
  });
}

async function readAdminItem(
  db: Prisma.TransactionClient | typeof prisma,
  key: SiteContentKey,
): Promise<AdminSiteContentItem> {
  const row = await db.siteContent.findUnique({ where: { key }, select: adminRowSelect });
  const [item] = await toAdminItems(db, [{ key, row }]);
  if (!item) throw new Error(`site content: no admin item for "${key}"`);
  return item;
}

/** Replaces the rows that say which uploaded files the block uses. Dropped files are left to the cleanup sweep. */
async function replaceSiteFiles(
  tx: Prisma.TransactionClient,
  key: SiteContentKey,
  fileIds: string[],
): Promise<void> {
  await tx.siteContentFile.deleteMany({ where: { key } });
  if (fileIds.length > 0) {
    await tx.siteContentFile.createMany({ data: fileIds.map((fileId) => ({ key, fileId })) });
  }
}

/** Card sources are internal: the public answer never shows them. */
function withoutSources<T extends { items?: unknown }>(block: T): T {
  if (!Array.isArray(block.items)) return block;
  const items = block.items.map((item: unknown) =>
    Object.fromEntries(Object.entries(item as object).filter(([field]) => field !== "source")),
  );
  return { ...block, items } as T;
}

/** The ten landing blocks. Rows are read in one query; a missing or invalid row shows its default. */
export async function getSiteContent(): Promise<SiteContentResponse> {
  const rows = await prisma.siteContent.findMany({
    where: { key: { in: [...LANDING_KEYS] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value] as const));

  const block = <K extends SiteContentKey>(key: K): BlockValue<K> =>
    byKey.has(key) ? readBlock(key, byKey.get(key)) : defaultFor(key);

  const values = {
    hero: block("hero"),
    nav: block("nav"),
    categories: block("categories"),
    testimonials: block("testimonials"),
    showcase: block("showcase"),
    how_it_works: block("how_it_works"),
    faq: block("faq"),
    cta_banner: block("cta_banner"),
    footer: block("footer"),
    seo: block("seo"),
  };
  const files = await mediaFilesFor(prisma, Object.values(values));

  return {
    hero: await serveBlock("hero", values.hero, files),
    nav: await serveBlock("nav", values.nav, files),
    categories: await serveBlock("categories", values.categories, files),
    testimonials: withoutSources(await serveBlock("testimonials", values.testimonials, files)),
    showcase: withoutSources(await serveBlock("showcase", values.showcase, files)),
    how_it_works: await serveBlock("how_it_works", values.how_it_works, files),
    faq: await serveBlock("faq", values.faq, files),
    cta_banner: await serveBlock("cta_banner", values.cta_banner, files),
    footer: await serveBlock("footer", values.footer, files),
    seo: await serveBlock("seo", values.seo, files),
  };
}

/** One static page by its public slug. updatedAt is null while the page shows its default. */
export async function getSitePage(slug: PageSlug): Promise<SitePageResponse> {
  const key = PAGE_SLUGS[slug];
  const row = await prisma.siteContent.findUnique({
    where: { key },
    select: { value: true, updatedAt: true },
  });
  const stored = row ? readBlock(key, row.value) : defaultFor(key);
  const page = await serveBlock(key, stored, await mediaFilesFor(prisma, [stored]));
  return {
    slug,
    title: page.title,
    description: page.description,
    body: page.body,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Every site content key in SITE_CONTENT_KEYS order, for the admin editor. */
export async function listAdminSiteContent(): Promise<AdminSiteContentItem[]> {
  const rows = await prisma.siteContent.findMany({
    where: { key: { in: [...SITE_CONTENT_KEYS] } },
    select: adminRowSelect,
  });
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  return toAdminItems(
    prisma,
    SITE_CONTENT_KEYS.map((key) => ({ key, row: byKey.get(key) ?? null })),
  );
}

/**
 * Replaces the whole block. expectedUpdatedAt is the updatedAt the editor loaded, or null when it
 * loaded the default. Saving the same value again writes nothing.
 */
export async function updateSiteContent(
  key: SiteContentKey,
  value: unknown,
  expectedUpdatedAt: string | null,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminSiteContentItem> {
  const parsed = (BLOCK_SCHEMAS[key] as z.ZodType).safeParse(value);
  if (!parsed.success) {
    throw validationIssuesError(
      "Invalid site content",
      parsed.error.issues.map((issue) => ({
        path: ["value", ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    );
  }
  const next = parsed.data as Prisma.InputJsonValue;
  const refs = collectFileRefs(next);
  const fileIds = [...new Set(refs.map((ref) => ref.fileId))];
  const sources = itemSources(key, next).map(({ index, source }) => ({ index, source }));

  const { item, saved } = await prisma.$transaction(async (tx) => {
    // Source rows first, before the block row is read: the lock order every path follows.
    const infos = await lockCardSources(
      tx,
      sources.map((entry) => entry.source),
    );

    const row = await tx.siteContent.findUnique({
      where: { key },
      select: { value: true, updatedAt: true },
    });
    const current = row?.updatedAt.toISOString() ?? null;
    const expected = expectedUpdatedAt === null ? null : new Date(expectedUpdatedAt).toISOString();
    if (current !== expected) throw conflict();

    const problems = sourceIssues(key, next, infos);
    if (problems.length > 0) throw validationIssuesError("Invalid site content", problems);

    // A story or tutor video file is only allowed on the card that owns it.
    const owned = new Map<number, Set<string>>();
    for (const { index, source } of sources) {
      owned.set(index, new Set(infos.get(sourceKey(source))?.fileIds ?? []));
    }
    await assertFileRefs(tx, refs, owned);

    const previous = row ? readBlock(key, row.value) : defaultFor(key);
    if (isDeepStrictEqual(previous, next)) {
      return { item: await readAdminItem(tx, key), saved: false };
    }

    // The updatedAt filter makes the write fail when another save landed after the check above.
    if (row) {
      const result = await tx.siteContent.updateMany({
        where: { key, updatedAt: row.updatedAt },
        data: { value: next, updatedById: admin.accountId },
      });
      if (result.count === 0) throw conflict();
    } else {
      try {
        await tx.siteContent.create({ data: { key, value: next, updatedById: admin.accountId } });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict();
        throw error;
      }
    }

    await replaceSiteFiles(tx, key, fileIds);

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "site_content.update",
      entityType: "site_content",
      entityId: key,
      before: { value: previous as Prisma.InputJsonValue },
      after: { value: next },
      ip: ip ?? null,
    });

    return { item: await readAdminItem(tx, key), saved: true };
  });

  if (!saved) return item;
  // After the commit: the files are public-worthy only once the block that uses them is saved.
  // The answer is read again so its media URLs are the published ones.
  for (const fileId of fileIds) await publishFile(fileId);
  return readAdminItem(prisma, key);
}

/**
 * Refuses a block whose media points at a file that is missing, not finished uploading, of the wrong
 * kind, or a story or tutor video file on a card that does not own it. The rows are locked FOR
 * UPDATE, so the cleanup sweep cannot remove one before the join rows are written.
 */
async function assertFileRefs(
  tx: Prisma.TransactionClient,
  refs: FileRef[],
  owned: Map<number, Set<string>>,
): Promise<void> {
  if (refs.length === 0) return;
  const ids = [...new Set(refs.map((ref) => ref.fileId))];
  const rows = await tx.$queryRaw<{ id: string; status: string; purpose: string }[]>`
    SELECT id::text AS id, status::text AS status, purpose::text AS purpose
    FROM file_asset
    WHERE id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE`;
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  const issues = refs.flatMap((ref) => {
    const path = ["value", ...ref.path.map(String)].join(".");
    const row = byId.get(ref.fileId);
    if (row?.status !== "UPLOADED") {
      return [
        {
          path,
          message: "This file is gone or not finished uploading. Upload it again.",
        },
      ];
    }
    if (!ACCEPTED_PURPOSES[ref.kind].includes(row.purpose)) {
      return [
        {
          path,
          message: ref.kind === "image" ? "Upload an image here." : "Upload a video here.",
        },
      ];
    }
    if (OWNED_PURPOSES.has(row.purpose)) {
      const index = ref.path[0] === "items" ? Number(ref.path[1]) : -1;
      if (!owned.get(index)?.has(ref.fileId)) {
        return [
          {
            path,
            message: "This file belongs to a user's submission. Add it with Add from submissions.",
          },
        ];
      }
    }
    return [];
  });
  if (issues.length > 0) throw validationIssuesError("Invalid site content", issues);
}

/** Deletes the row so the block follows the defaults again. A block with no row answers its default. */
export async function resetSiteContent(
  key: SiteContentKey,
  expectedUpdatedAt: string | undefined,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminSiteContentItem> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.siteContent.findUnique({
      where: { key },
      select: { value: true, updatedAt: true },
    });
    if (!row) return toAdminItem(key, null, defaultFor(key), {});

    if (
      expectedUpdatedAt !== undefined &&
      new Date(expectedUpdatedAt).toISOString() !== row.updatedAt.toISOString()
    ) {
      throw conflict();
    }

    // The join rows go with the row (ON DELETE CASCADE).
    const result = await tx.siteContent.deleteMany({
      where: { key, updatedAt: row.updatedAt },
    });
    if (result.count === 0) throw conflict();

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "site_content.reset",
      entityType: "site_content",
      entityId: key,
      before: { value: readBlock(key, row.value) as Prisma.InputJsonValue },
      after: { value: defaultFor(key) as Prisma.InputJsonValue },
      ip: ip ?? null,
    });

    return toAdminItem(key, null, defaultFor(key), {});
  });
}

// ── Picker for admins ──────────────────────────────────────────

const SOURCE_LIMIT = 100;

/**
 * Submissions an admin can add to a card list. testimonials: approved student stories. showcase:
 * approved tutor stories (comment cards) and approved tutor videos the tutor agreed to show (video
 * cards). Only active authors. Newest first, at most SOURCE_LIMIT.
 */
export async function listSiteSources(forKey: CardKey): Promise<AdminSiteSource[]> {
  const onLanding = await landingSourceKeys();
  const subjectSelect = { take: 1, select: { subject: { select: { name: true } } } } as const;

  const stories = await prisma.story.findMany({
    where: {
      status: "APPROVED",
      role: forKey === "testimonials" ? "STUDENT" : "TUTOR",
      account: { status: "ACTIVE" },
    },
    orderBy: [{ consentAt: "desc" }, { id: "desc" }],
    take: SOURCE_LIMIT,
    include: {
      image: true,
      video: true,
      account: {
        select: {
          student: { select: { name: true } },
          tutor: { select: { name: true, instituteName: true, subjects: subjectSelect } },
        },
      },
    },
  });

  const videos =
    forKey === "showcase"
      ? await prisma.tutorVideo.findMany({
          where: {
            status: "APPROVED",
            landingConsentAt: { not: null },
            tutor: { account: { status: "ACTIVE" } },
          },
          orderBy: [{ landingConsentAt: "desc" }, { id: "desc" }],
          take: SOURCE_LIMIT,
          include: {
            file: true,
            tutor: { select: { name: true, instituteName: true, subjects: subjectSelect } },
          },
        })
      : [];

  // Every file the listed submissions use, in one place, so each card can pick its own.
  const files = new Map<string, MediaFile>();
  for (const story of stories) {
    for (const file of [story.image, story.video]) if (file) files.set(file.id, file);
  }
  for (const video of videos) files.set(video.file.id, video.file);
  const media: AdminMedia = {};
  for (const file of files.values()) {
    media[file.id] = {
      url: await fileUrl(file),
      contentType: file.contentType,
      originalName: file.originalName,
      // Only media purposes are loaded (mediaFilesFor and the source queries filter on them).
      purpose: file.purpose as MediaPurpose,
    };
  }
  const pick = (ids: (string | null)[]): AdminMedia => {
    const picked: AdminMedia = {};
    for (const id of ids) if (id && media[id]) picked[id] = media[id];
    return picked;
  };

  const entries: { consentAt: Date; item: AdminSiteSource }[] = [];
  for (const story of stories) {
    const { student, tutor } = story.account;
    entries.push({
      consentAt: story.consentAt,
      item: {
        source: { kind: "story", id: story.id },
        authorName: (story.role === "STUDENT" ? student?.name : tutor?.name) ?? "",
        // The story CHECK allows STUDENT and TUTOR only.
        role: story.role as "STUDENT" | "TUTOR",
        headline: story.headline,
        body: story.body,
        title: null,
        imageRef: story.imageFileId ? `file:${story.imageFileId}` : null,
        videoRef: story.videoFileId ? `file:${story.videoFileId}` : null,
        media: pick([story.imageFileId, story.videoFileId]),
        subjectHint: tutor?.subjects[0]?.subject.name ?? null,
        instituteHint: tutor?.instituteName ?? null,
        consentAt: story.consentAt,
        onLanding: onLanding.has(`story:${story.id}`),
      },
    });
  }

  for (const video of videos) {
    const consentAt = video.landingConsentAt ?? video.createdAt;
    entries.push({
      consentAt,
      item: {
        source: { kind: "tutor_video", id: video.id },
        authorName: video.tutor.name,
        role: "TUTOR",
        headline: null,
        body: null,
        title: video.title,
        imageRef: null,
        videoRef: `file:${video.fileId}`,
        media: pick([video.fileId]),
        subjectHint: video.tutor.subjects[0]?.subject.name ?? null,
        instituteHint: video.tutor.instituteName ?? null,
        consentAt,
        onLanding: onLanding.has(`tutor_video:${video.id}`),
      },
    });
  }

  entries.sort((a, b) => b.consentAt.getTime() - a.consentAt.getTime());
  return entries.slice(0, SOURCE_LIMIT).map(({ item }) => item);
}
