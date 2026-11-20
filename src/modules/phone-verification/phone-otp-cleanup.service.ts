import { prisma } from "../../lib/prisma.js";

// A code is valid for 5 minutes and the send caps look back one hour; a day keeps every row that any
// rule still reads, including the 30-minute sign-up window.
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Deletes OTP rows created more than a day before `now`. */
export async function runPhoneOtpCleanup(now = new Date()): Promise<{ deleted: number }> {
  const { count } = await prisma.phoneOtp.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  return { deleted: count };
}
