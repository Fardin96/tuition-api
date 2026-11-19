import { z } from "zod";
import { PostStatus } from "../../generated/prisma/enums.js";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const titleSchema = z.string().trim().min(3).max(160);
const slugSchema = z
  .string()
  .max(120)
  .regex(SLUG_PATTERN, "Use lowercase letters, digits and dashes");
const excerptSchema = z.string().trim().max(300).nullable();
const bodySchema = z.string().min(1).max(50_000);
const coverFileIdSchema = z.string().uuid().nullable();

export const blogPostIdParamSchema = z.object({ id: z.string().uuid() });
export type BlogPostIdParam = z.infer<typeof blogPostIdParamSchema>;

export const adminBlogCoverSchema = z.object({
  fileId: z.string(),
  url: z.string().nullable(),
});

export const adminBlogPostSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    excerpt: z.string().nullable(),
    body: z.string(),
    status: z.nativeEnum(PostStatus),
    publishedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    authorId: z.string(),
    authorName: z.string(),
    cover: adminBlogCoverSchema.nullable(),
  })
  .meta({ id: "AdminBlogPost" });
export type AdminBlogPostResponse = z.infer<typeof adminBlogPostSchema>;

export const adminBlogPostPageSchema = z
  .object({
    posts: z.array(adminBlogPostSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminBlogPostPage" });
export type AdminBlogPostPageResponse = z.infer<typeof adminBlogPostPageSchema>;

export const adminBlogListQuerySchema = z.object({
  status: z.nativeEnum(PostStatus).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminBlogListQuery = z.infer<typeof adminBlogListQuerySchema>;

// A new post starts as a draft unless status says otherwise. A slug is generated from the title when omitted.
export const createBlogPostSchema = z
  .object({
    title: titleSchema,
    slug: slugSchema.optional(),
    excerpt: excerptSchema.optional(),
    body: bodySchema,
    coverFileId: coverFileIdSchema.optional(),
    status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
  })
  .strict()
  .meta({ id: "CreateBlogPost" });
export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>;

// Every field optional. coverFileId null removes the cover. At least one field must be sent.
export const updateBlogPostSchema = z
  .object({
    title: titleSchema.optional(),
    slug: slugSchema.optional(),
    excerpt: excerptSchema.optional(),
    body: bodySchema.optional(),
    coverFileId: coverFileIdSchema.optional(),
    status: z.nativeEnum(PostStatus).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdateBlogPost" });
export type UpdateBlogPostInput = z.infer<typeof updateBlogPostSchema>;
