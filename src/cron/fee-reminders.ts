import { prisma } from "../lib/prisma.js";
import { runFeeReminders } from "../modules/fees/fee-reminder.service.js";

async function main() {
  const result = await runFeeReminders();
  console.log(`fee-reminders complete: ${result.queued} payment reminders queued`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
