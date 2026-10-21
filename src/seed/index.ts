import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

const SUPER_ADMINS = [
  { slot: 1, email: env.SUPER_ADMIN_EMAIL_1 },
  { slot: 2, email: env.SUPER_ADMIN_EMAIL_2 },
];

async function main() {
  for (const admin of SUPER_ADMINS) {
    await prisma.superAdminEmail.upsert({
      where: { slot: admin.slot },
      create: admin,
      update: { email: admin.email },
    });
  }

  console.log(`Seeded ${SUPER_ADMINS.length} super-admin email(s)`);

  // shortcut: placeholder lookups with fixed ids, mirrored in tution-media/lib/profile.ts
  // (AREAS, SUBJECTS). Replace areas when Google Places is integrated; keep both lists in step until then.
  for (const [i, name] of AREAS.entries()) {
    await prisma.area.upsert({
      where: { id: i + 1 },
      create: { id: i + 1, division: "Dhaka", district: "Dhaka", name },
      update: { name },
    });
  }
  for (const [i, name] of SUBJECTS.entries()) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    await prisma.subject.upsert({
      where: { id: i + 1 },
      create: { id: i + 1, name, slug, sortOrder: i },
      update: { name, slug, sortOrder: i },
    });
  }
  // Explicit ids don't advance the serial sequences; move them past the seeded rows.
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('area', 'id'), (SELECT MAX(id) FROM area))`,
  );
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('subject', 'id'), (SELECT MAX(id) FROM subject))`,
  );

  console.log(`Seeded ${AREAS.length} areas and ${SUBJECTS.length} subjects`);
}

const AREAS = [
  "Dhanmondi",
  "Gulshan",
  "Banani",
  "Uttara",
  "Mirpur",
  "Mohammadpur",
  "Bashundhara",
  "Badda",
  "Rampura",
  "Khilgaon",
  "Motijheel",
  "Old Dhaka",
  "Lalmatia",
  "Tejgaon",
  "Farmgate",
  "Shyamoli",
  "Malibagh",
  "Moghbazar",
  "Wari",
  "Jatrabari",
];

const SUBJECTS = [
  "Bangla",
  "English",
  "Mathematics",
  "Higher Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "ICT",
  "Accounting",
  "Finance",
  "Economics",
  "General Science",
  "Religion",
  "Arabic",
];

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
