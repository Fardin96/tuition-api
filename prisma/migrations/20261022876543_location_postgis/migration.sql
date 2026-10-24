-- Enable PostGIS for GEOGRAPHY columns.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateTable
CREATE TABLE "tutor_location" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tutor_id" UUID NOT NULL,
    "place_id" TEXT NOT NULL,
    "address_text" TEXT NOT NULL,
    "district_code" TEXT NOT NULL,
    "geog" GEOGRAPHY(POINT,4326),
    "geog_fetched_at" TIMESTAMPTZ(3),
    "needs_readdress" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_location" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "place_id" TEXT NOT NULL,
    "address_text" TEXT NOT NULL,
    "district_code" TEXT NOT NULL,
    "geog" GEOGRAPHY(POINT,4326),
    "geog_fetched_at" TIMESTAMPTZ(3),
    "needs_readdress" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_location_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tutor_location_tutor_id_key" ON "tutor_location"("tutor_id");
CREATE UNIQUE INDEX "student_location_student_id_key" ON "student_location"("student_id");

-- AddForeignKey
ALTER TABLE "tutor_location" ADD CONSTRAINT "tutor_location_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "student_location" ADD CONSTRAINT "student_location_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Helper indexes for geo search.
CREATE INDEX "tutor_location_district_code_idx" ON "tutor_location"("district_code");
CREATE INDEX "student_location_district_code_idx" ON "student_location"("district_code");
CREATE INDEX "tutor_location_geog_gist_idx" ON "tutor_location" USING GIST ("geog");
CREATE INDEX "student_location_geog_gist_idx" ON "student_location" USING GIST ("geog");
CREATE INDEX "tutor_location_searchable_idx" ON "tutor_location"("district_code") WHERE NOT "needs_readdress" AND "geog" IS NOT NULL;
CREATE INDEX "student_location_searchable_idx" ON "student_location"("district_code") WHERE NOT "needs_readdress" AND "geog" IS NOT NULL;
