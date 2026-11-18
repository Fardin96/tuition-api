import { describe, expect, it } from "vitest";
import { prisma } from "./prisma.js";

// The pg driver adapter sends a Date without an offset; a non-UTC session would shift it.
describe("database session time zone", () => {
  it("runs in UTC", async () => {
    const [row] = await prisma.$queryRaw<
      { tz: string }[]
    >`select current_setting('TimeZone') as tz`;
    expect(row?.tz).toBe("UTC");
  });

  it("sends a Date as the same instant Postgres means by now()", async () => {
    const sent = new Date();
    const [row] = await prisma.$queryRaw<{ drift: number }[]>`
      select abs(extract(epoch from (now() - ${sent}::timestamptz)))::float8 as drift`;
    // A few seconds of clock and round-trip slack, far below a one-hour zone offset.
    expect(row?.drift).toBeLessThan(5);
  });
});
