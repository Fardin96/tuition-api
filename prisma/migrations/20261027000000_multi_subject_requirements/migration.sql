-- CreateTable
CREATE TABLE "requirement_subject" (
    "requirement_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,

    CONSTRAINT "requirement_subject_pkey" PRIMARY KEY ("requirement_id","subject_id")
);

-- CreateIndex
CREATE INDEX "requirement_subject_subject_id_requirement_id_idx" ON "requirement_subject"("subject_id", "requirement_id");

-- DropIndex
DROP INDEX "tuition_requirement_status_category_id_subject_id_area_id_c_idx";

-- Data Migration: Copy existing subject_id data to the new join table
INSERT INTO "requirement_subject" ("requirement_id", "subject_id")
SELECT "id", "subject_id" FROM "tuition_requirement" WHERE "subject_id" IS NOT NULL;

-- AlterTable
ALTER TABLE "tuition_requirement" DROP COLUMN "subject_id";

-- CreateIndex
CREATE INDEX "tuition_requirement_status_category_id_area_id_created_at_idx" ON "tuition_requirement"("status", "category_id", "area_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "requirement_subject" ADD CONSTRAINT "requirement_subject_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "tuition_requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_subject" ADD CONSTRAINT "requirement_subject_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
