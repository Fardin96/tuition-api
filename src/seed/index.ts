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

  // Areas, categories, and subjects are seed-once lookup tables.
  // Add them here when you have the data, or import from a CSV/JSON file.
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
