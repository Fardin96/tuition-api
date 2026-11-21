SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Site media: landing images and videos uploaded by admins, referenced from site_content as "file:<id>".

-- New values are only used by later transactions, which PostgreSQL 12+ allows inside one migration.
ALTER TYPE "FilePurpose" ADD VALUE 'SITE_IMAGE' AFTER 'BLOG_COVER';
ALTER TYPE "FilePurpose" ADD VALUE 'SITE_VIDEO' AFTER 'SITE_IMAGE';

-- Which uploaded files a site_content row uses. A new, empty table: the cleanup sweep and the
-- admin file list read it, and deleting a file that a block still uses is refused (RESTRICT).
CREATE TABLE "site_content_file" (
    "key" TEXT NOT NULL,
    "file_id" UUID NOT NULL,

    CONSTRAINT "site_content_file_pkey" PRIMARY KEY ("key", "file_id"),
    CONSTRAINT "site_content_file_key_fkey" FOREIGN KEY ("key") REFERENCES "site_content"("key") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "site_content_file_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- New, empty table: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "site_content_file_file_id_idx" ON "site_content_file"("file_id");
