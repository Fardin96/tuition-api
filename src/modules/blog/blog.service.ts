import type { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fileUrl } from "../files/files.service.js";
import type { BlogListQuery, BlogPostPageResponse, BlogPostResponse } from "./blog.schema.js";

// Only what readers need. Drafts and archived posts never reach these queries.
const publicInclude = {
  coverFile: { select: { storageKey: true, status: true, publishedAt: true } },
} as const;

type PublicRow = Prisma.BlogPostGetPayload<{ include: typeof publicInclude }>;

async function coverUrlOf(row: PublicRow): Promise<string | null> {
  return row.coverFile ? fileUrl(row.coverFile) : null;
}

// Newest first, keyset over (published_at, id).
export async function listPublishedPosts(query: BlogListQuery): Promise<BlogPostPageResponse> {
  const where: Prisma.BlogPostWhereInput = { status: "PUBLISHED" };
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = [
      { publishedAt: { lt: cursor.createdAt } },
      { publishedAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.blogPost.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: publicInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const posts = await Promise.all(
    page.map(async (row) => ({
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      publishedAt: row.publishedAt as Date,
      coverUrl: await coverUrlOf(row),
    })),
  );

  return {
    posts,
    nextCursor:
      hasMore && last?.publishedAt
        ? encodeCursor({ createdAt: last.publishedAt, id: last.id })
        : null,
  };
}

export async function getPublishedPost(slug: string): Promise<BlogPostResponse> {
  const row = await prisma.blogPost.findFirst({
    where: { slug, status: "PUBLISHED" },
    include: publicInclude,
  });
  if (!row?.publishedAt) throw notFound("Post not found");
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    coverUrl: await coverUrlOf(row),
  };
}
