import { z } from "zod";
import { FilePurpose, FileStatus } from "../../generated/prisma/enums.js";

export const fileIdParamSchema = z.object({ id: z.string().uuid() });
export type FileIdParam = z.infer<typeof fileIdParamSchema>;

export const fileAssetSchema = z
  .object({
    id: z.string(),
    purpose: z.nativeEnum(FilePurpose),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    status: z.nativeEnum(FileStatus),
    fileName: z.string().nullable(),
    createdAt: z.date(),
    uploadedAt: z.date().nullable(),
  })
  .meta({ id: "FileAsset" });
export type FileAssetResponse = z.infer<typeof fileAssetSchema>;

export const createUploadUrlSchema = z
  .object({
    purpose: z.nativeEnum(FilePurpose),
    contentType: z.string().trim().toLowerCase().min(1).max(100),
    sizeBytes: z.number().int().positive(),
    fileName: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: "CreateUploadUrl" });
export type CreateUploadUrlInput = z.infer<typeof createUploadUrlSchema>;

export const uploadUrlSchema = z
  .object({
    file: fileAssetSchema,
    uploadUrl: z.string(),
    method: z.literal("PUT"),
    headers: z.object({ "Content-Type": z.string() }),
    expiresAt: z.date(),
  })
  .meta({ id: "UploadUrl" });
export type UploadUrlResponse = z.infer<typeof uploadUrlSchema>;

export const downloadUrlSchema = z
  .object({ url: z.string(), expiresAt: z.date() })
  .meta({ id: "DownloadUrl" });
export type DownloadUrlResponse = z.infer<typeof downloadUrlSchema>;

/** Body of every endpoint that attaches an uploaded file. */
export const fileIdSchema = z.string().uuid();
