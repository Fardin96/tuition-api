import { prisma } from "../lib/prisma.js";
import { runLocationExpiry } from "../modules/location/location.service.js";

async function main() {
  const result = await runLocationExpiry();
  console.log(
    `weekly-location-expiry complete: ` +
      `${result.softWarning.tutorCount} tutor soft warnings, ` +
      `${result.softWarning.studentCount} student soft warnings, ` +
      `${result.hardExpiry.tutorCount} tutor hard expiries, ` +
      `${result.hardExpiry.studentCount} student hard expiries`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
