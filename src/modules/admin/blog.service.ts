import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  claimFile,
  discardFile,
  fileUrl,
  publishFile,
  removeObjects,
} from "../files/files.service.js";
import type {
  AdminBlogListQuery,
  AdminBlogPostPageResponse,
  AdminBlogPostResponse,
  CreateBlogPostInput,
  UpdateBlogPostInput,
} from "./blog.schema.js";

const adminInclude = {
  author: { select: { name: true } },
  coverFile: { select: { id: true, storageKey: true, status: true, publishedAt: true } },
} as const;

type AdminRow = Prisma.BlogPostGetPayload<{ include: typeof adminInclude }>;

async function toAdminPost(row: AdminRow): Promise<AdminBlogPostResponse> {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    status: row.status,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    authorId: row.authorId,
    authorName: row.author.name,
    cover: row.coverFile ? { fileId: row.coverFile.id, url: await fileUrl(row.coverFile) } : null,
  };
}

/** URL slug from a title: ASCII letters and digits joined by dashes, at most 120 characters. */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

function slugTaken() {
  return appError("BlogSlugExists", 409, "A post with that slug already exists.");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// Keyset over (updated_at, id), newest first. Optional status filter.
export async function listAdminBlogPosts(
  query: AdminBlogListQuery,
): Promise<AdminBlogPostPageResponse> {
  const clauses: Prisma.BlogPostWhereInput[] = [];
  if (query.status) clauses.push({ status: query.status });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { updatedAt: { lt: cursor.createdAt } },
        { updatedAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.blogPost.findMany({
    where: { AND: clauses },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: adminInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    posts: await Promise.all(page.map(toAdminPost)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.updatedAt, id: last.id }) : null,
  };
}

export async function getAdminBlogPost(id: string): Promise<AdminBlogPostResponse> {
  const row = await prisma.blogPost.findUnique({ where: { id }, include: adminInclude });
  if (!row) throw notFound("Post not found");
  return toAdminPost(row);
}

export async function createBlogPost(
  input: CreateBlogPostInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminBlogPostResponse> {
  const slug = input.slug ?? slugify(input.title);
  if (!slug) {
    throw validationIssuesError("Invalid post", [
      { path: "title", message: "Use letters or digits in the title, or send a slug" },
    ]);
  }
  const status = input.status ?? "DRAFT";
  const coverFileId = input.coverFileId ?? null;

  let id: string;
  try {
    id = await prisma.$transaction(async (tx) => {
      if (coverFileId) {
        await claimFile(tx, {
          fileId: coverFileId,
          ownerAccountId: admin.accountId,
          purpose: "BLOG_COVER",
        });
      }
      const row = await tx.blogPost.create({
        data: {
          slug,
          title: input.title,
          excerpt: input.excerpt || null,
          body: input.body,
          status,
          publishedAt: status === "PUBLISHED" ? new Date() : null,
          coverFileId,
          authorId: admin.accountId,
        },
        select: { id: true },
      });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "blog.create",
        entityType: "blog_post",
        entityId: row.id,
        after: { slug, title: input.title, status, coverFileId },
        ip: ip ?? null,
      });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }

  if (coverFileId) await publishFile(coverFileId);
  return getAdminBlogPost(id);
}

// publishedAt is set on the first move to PUBLISHED and kept after that.
export async function updateBlogPost(
  id: string,
  input: UpdateBlogPostInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminBlogPostResponse> {
  let coverToPublish: string | null = null;
  try {
    coverToPublish = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM blog_post WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.blogPost.findUnique({ where: { id } });
      if (!current) throw notFound("Post not found");

      const data: Prisma.BlogPostUncheckedUpdateInput = {};
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      const track = (field: string, prev: string | null, next: string | null) => {
        if (prev !== next) {
          before[field] = prev;
          after[field] = next;
        }
      };

      if (input.title !== undefined) {
        data.title = input.title;
        track("title", current.title, input.title);
      }
      if (input.slug !== undefined) {
        data.slug = input.slug;
        track("slug", current.slug, input.slug);
      }
      if (input.excerpt !== undefined) {
        const excerpt = input.excerpt || null;
        data.excerpt = excerpt;
        track("excerpt", current.excerpt, excerpt);
      }
      if (input.body !== undefined) {
        data.body = input.body;
        // Bodies can be long; the audit records that they changed, not the text.
        if (input.body !== current.body) after.body = "changed";
      }
      if (input.status !== undefined) {
        data.status = input.status;
        track("status", current.status, input.status);
        if (input.status === "PUBLISHED" && !current.publishedAt) {
          data.publishedAt = new Date();
        }
      }

      let newCover: string | null = null;
      if (input.coverFileId !== undefined && input.coverFileId !== current.coverFileId) {
        if (input.coverFileId) {
          await claimFile(tx, {
            fileId: input.coverFileId,
            ownerAccountId: admin.accountId,
            purpose: "BLOG_COVER",
          });
          newCover = input.coverFileId;
        }
        // The old cover is left for the cleanup cron: it is unreferenced, not discarded.
        data.coverFileId = input.coverFileId;
        track("coverFileId", current.coverFileId, input.coverFileId);
      }

      await tx.blogPost.update({ where: { id }, data });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "blog.update",
        entityType: "blog_post",
        entityId: id,
        before: Object.keys(before).length ? before : null,
        after: Object.keys(after).length ? after : null,
        ip: ip ?? null,
      });
      return newCover;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw slugTaken();
    throw error;
  }

  if (coverToPublish) await publishFile(coverToPublish);
  return getAdminBlogPost(id);
}

// Drafts only. Archive a published post instead. The cover file is discarded with the post.
export async function deleteBlogPost(
  id: string,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<void> {
  const removed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM blog_post WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.blogPost.findUnique({
      where: { id },
      select: { status: true, slug: true, coverFileId: true },
    });
    if (!current) throw notFound("Post not found");
    if (current.status !== "DRAFT") {
      throw appError("InvalidPostState", 409, "Only drafts can be deleted. Archive it instead.");
    }

    await tx.blogPost.delete({ where: { id } });
    const cover = current.coverFileId ? await discardFile(tx, current.coverFileId) : null;
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "blog.delete",
      entityType: "blog_post",
      entityId: id,
      before: { slug: current.slug, status: current.status, coverFileId: current.coverFileId },
      ip: ip ?? null,
    });
    return cover;
  });
  if (removed) await removeObjects([removed]);
}
