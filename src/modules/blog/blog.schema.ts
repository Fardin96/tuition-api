import { z } from "zod";

export const blogSlugParamSchema = z.object({ slug: z.string().min(1).max(120) });
export type BlogSlugParam = z.infer<typeof blogSlugParamSchema>;

export const blogPostSummarySchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    excerpt: z.string().nullable(),
    publishedAt: z.date(),
    coverUrl: z.string().nullable(),
  })
  .meta({ id: "BlogPostSummary" });

export const blogPostSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    excerpt: z.string().nullable(),
    body: z.string(),
    publishedAt: z.date(),
    updatedAt: z.date(),
    coverUrl: z.string().nullable(),
  })
  .meta({ id: "BlogPost" });

export const blogPostPageSchema = z
  .object({
    posts: z.array(blogPostSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "BlogPostPage" });

export const blogListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BlogListQuery = z.infer<typeof blogListQuerySchema>;
export type BlogPostResponse = z.infer<typeof blogPostSchema>;
export type BlogPostPageResponse = z.infer<typeof blogPostPageSchema>;
