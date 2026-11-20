import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { createAccount } from "../../tests/helpers.js";
import { runPhoneOtpCleanup } from "./phone-otp-cleanup.service.js";

const HOUR = 60 * 60 * 1000;

async function insertOtp(accountId: string, createdAt: Date) {
  return prisma.phoneOtp.create({
    data: {
      accountId,
      phoneNumber: "+8801712345678",
      codeHash: "00",
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
      createdAt,
    },
  });
}

describe("runPhoneOtpCleanup", () => {
  it("deletes rows created more than 24 hours ago and keeps newer ones", async () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const account = await createAccount({ role: "STUDENT" });
    const old = await insertOtp(account.id, new Date(now.getTime() - 25 * HOUR));
    const recent = await insertOtp(account.id, new Date(now.getTime() - 23 * HOUR));

    const result = await runPhoneOtpCleanup(now);

    expect(result).toEqual({ deleted: 1 });
    const left = await prisma.phoneOtp.findMany({ where: { accountId: account.id } });
    expect(left.map((row) => row.id)).toEqual([recent.id]);
    expect(left.some((row) => row.id === old.id)).toBe(false);
  });

  it("does nothing when every row is recent", async () => {
    const now = new Date();
    const account = await createAccount({ role: "TUTOR" });
    await insertOtp(account.id, new Date(now.getTime() - HOUR));

    expect(await runPhoneOtpCleanup(now)).toEqual({ deleted: 0 });
    expect(await prisma.phoneOtp.count({ where: { accountId: account.id } })).toBe(1);
  });
});
