-- AlterTable
ALTER TABLE "tuition_requirement" ALTER COLUMN "category_id" DROP NOT NULL,
ALTER COLUMN "area_id" DROP NOT NULL,
ALTER COLUMN "subject_id" DROP NOT NULL,
ALTER COLUMN "class_level" DROP NOT NULL,
ALTER COLUMN "time_of_day" DROP NOT NULL,
ALTER COLUMN "days_per_week" DROP NOT NULL,
ALTER COLUMN "salary" DROP NOT NULL,
ALTER COLUMN "student_count" DROP NOT NULL,
ALTER COLUMN "hire_by_date" DROP NOT NULL,
ALTER COLUMN "tuition_type" DROP NOT NULL;
