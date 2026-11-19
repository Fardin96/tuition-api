import { z } from "zod";
import { FilePurpose, FileStatus } from "../../generated/prisma/enums.js";
import { fileAssetSchema } from "../files/files.schema.js";
import { noteVisibleSchema, reviewNoteSchema } from "../files/upload-review.schema.js";

// Every uploaded file as admins see it: who owns it, whether it is public and whether a record uses it.
export const adminFileSchema = fileAssetSchema
  .extend({
    ownerAccountId: z.string(),
    ownerEmail: z.string(),
    published: z.boolean(),
    inUse: z.boolean(),
  })
  .meta({ id: "AdminFile" });
export type AdminFileResponse = z.infer<typeof adminFileSchema>;

export const adminFilePageSchema = z
  .object({
    files: z.array(adminFileSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminFilePage" });

export const adminFileListQuerySchema = z.object({
  purpose: z.nativeEnum(FilePurpose).optional(),
  status: z.nativeEnum(FileStatus).optional(),
  ownerAccountId: z.string().uuid().optional(),
  unattached: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminFileListQuery = z.infer<typeof adminFileListQuerySchema>;

export const adminFileStatsSchema = z
  .object({
    groups: z.array(
      z.object({
        purpose: z.nativeEnum(FilePurpose),
        status: z.nativeEnum(FileStatus),
        count: z.number().int(),
        totalBytes: z.number().int(),
      }),
    ),
  })
  .meta({ id: "AdminFileStats" });
export type AdminFileStatsResponse = z.infer<typeof adminFileStatsSchema>;

export const adminFileIdParamSchema = z.object({ id: z.string().uuid() });
export type AdminFileIdParam = z.infer<typeof adminFileIdParamSchema>;

// Takes an uploaded file down. The note goes to the uploader; unverify also rejects an approved ID.
export const removeFileSchema = z
  .object({
    note: reviewNoteSchema,
    noteVisible: noteVisibleSchema,
    unverify: z.boolean().default(false),
  })
  .strict()
  .meta({ id: "RemoveFile" });
export type RemoveFileInput = z.infer<typeof removeFileSchema>;
