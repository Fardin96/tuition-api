import { prisma } from "../lib/prisma.js";
import { runPhoneOtpCleanup } from "../modules/phone-verification/phone-otp-cleanup.service.js";

async function main() {
  const result = await runPhoneOtpCleanup();
  console.log(`phone-otp-cleanup complete: deleted ${result.deleted}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
