import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { setSmsSenderForTests } from "../../lib/sms.js";
import {
  createAccount,
  createArea,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";
import { sendPhoneOtp, verifyPhoneOtp } from "./phone-verification.service.js";

type InjectOptions = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  payload?: object;
};

const BASE = "/api/v1/phone-verification";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// A valid Bangladeshi mobile number that no other test shares.
function bdNumber() {
  return `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

// The SMS test sender records every message; codes are read from them.
let sent: { to: string; msg: string }[] = [];

beforeEach(() => {
  sent = [];
  setSmsSenderForTests(async (to, msg) => {
    sent.push({ to, msg });
  });
});

afterEach(() => {
  setSmsSenderForTests(null);
});

function codeFromLastSms() {
  const last = sent.at(-1);
  const match = last?.msg.match(/code is (\d{6})\./);
  if (!match) throw new Error("no code in the last SMS");
  return match[1];
}

// A code that is certainly wrong for the current row.
function wrongCode(code: string) {
  return code === "000000" ? "111111" : "000000";
}

async function studentWithProfile(overrides: { phoneNumber?: string } = {}) {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const profile = await createStudentProfile(account.id, area.id, {
    phoneNumber: overrides.phoneNumber,
  });
  return { account, profile, headers: await getAuthHeaders(account) };
}

async function tutorWithProfile(overrides: { phoneNumber?: string } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const profile = await createTutorProfile(account.id, { phoneNumber: overrides.phoneNumber });
  return { account, profile, headers: await getAuthHeaders(account) };
}

// Each call builds a fresh app, like the rest of the suite.
async function inject(opts: InjectOptions) {
  const app = await createTestApp();
  return app.inject(opts);
}

async function send(headers: Record<string, string>, phoneNumber: string) {
  return inject({ method: "POST", url: `${BASE}/send`, headers, payload: { phoneNumber } });
}

async function verify(headers: Record<string, string>, phoneNumber: string, code: string) {
  return inject({
    method: "POST",
    url: `${BASE}/verify`,
    headers,
    payload: { phoneNumber, code },
  });
}

// Sends a code for the number and returns it, bypassing nothing: the first send is never cooled down.
async function sendAndReadCode(headers: Record<string, string>, phoneNumber: string) {
  const res = await send(headers, phoneNumber);
  expect(res.statusCode).toBe(200);
  return codeFromLastSms();
}

// Makes the latest row for the number look older, so the cooldown lets a second send through.
async function ageLatestRow(accountId: string, phoneNumber: string, ms: number) {
  const latest = await prisma.phoneOtp.findFirst({
    where: { accountId, phoneNumber },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) throw new Error("no row to age");
  await prisma.phoneOtp.update({
    where: { id: latest.id },
    data: { createdAt: new Date(latest.createdAt.getTime() - ms) },
  });
}

describe("GET /phone-verification", () => {
  it("reports the switch for the caller's own role", async () => {
    await setPlatformSetting("require_student_phone_verification", true);
    const student = await studentWithProfile();
    const tutor = await tutorWithProfile();

    const studentRes = await inject({
      method: "GET",
      url: BASE,
      headers: student.headers,
    });
    expect(studentRes.statusCode).toBe(200);
    expect(studentRes.headers["cache-control"]).toBe("private, no-store");
    expect(studentRes.json()).toMatchObject({ required: true, verifiedAt: null });

    const tutorRes = await inject({ method: "GET", url: BASE, headers: tutor.headers });
    expect(tutorRes.json()).toMatchObject({ required: false });
  });

  it("flips with the tutor switch and not the student one", async () => {
    await setPlatformSetting("require_tutor_phone_verification", true);
    const student = await studentWithProfile();
    const tutor = await tutorWithProfile();

    const studentRes = await inject({ method: "GET", url: BASE, headers: student.headers });
    expect(studentRes.json()).toMatchObject({ required: false });
    const tutorRes = await inject({ method: "GET", url: BASE, headers: tutor.headers });
    expect(tutorRes.json()).toMatchObject({ required: true });
  });

  it("returns the profile's number and verification time, and nulls with no profile", async () => {
    const verifiedAt = new Date("2026-11-19T10:00:00.000Z");
    const phoneNumber = bdNumber();
    const student = await studentWithProfile({ phoneNumber });
    await prisma.student.update({
      where: { accountId: student.account.id },
      data: { phoneVerifiedAt: verifiedAt },
    });
    const res = await inject({ method: "GET", url: BASE, headers: student.headers });
    expect(res.json()).toMatchObject({ phoneNumber, verifiedAt: verifiedAt.toISOString() });

    const bare = await createAccount({ role: "STUDENT" });
    const bareRes = await inject({
      method: "GET",
      url: BASE,
      headers: await getAuthHeaders(bare),
    });
    expect(bareRes.json()).toMatchObject({ phoneNumber: null, verifiedAt: null });
  });

  it("returns pendingVerification only without a profile, for a verified code not yet spent", async () => {
    const bare = await createAccount({ role: "STUDENT" });
    const headers = await getAuthHeaders(bare);
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(headers, phoneNumber);
    expect((await verify(headers, phoneNumber, code)).statusCode).toBe(200);

    const pending = await inject({ method: "GET", url: BASE, headers });
    expect(pending.json()).toMatchObject({
      phoneNumber: null,
      pendingVerification: { phoneNumber },
    });

    // A verification older than the 30 minute sign-up window no longer counts.
    await prisma.phoneOtp.updateMany({
      where: { accountId: bare.id },
      data: { verifiedAt: new Date(Date.now() - 31 * MINUTE) },
    });
    const stale = await inject({ method: "GET", url: BASE, headers });
    expect(stale.json().pendingVerification).toBeNull();

    // With a profile, the verification is on the profile and nothing is pending.
    const withProfile = await studentWithProfile();
    const profileNumber = bdNumber();
    const profileCode = await sendAndReadCode(withProfile.headers, profileNumber);
    expect((await verify(withProfile.headers, profileNumber, profileCode)).statusCode).toBe(200);
    const profileRes = await inject({ method: "GET", url: BASE, headers: withProfile.headers });
    expect(profileRes.json()).toMatchObject({
      phoneNumber: profileNumber,
      pendingVerification: null,
    });
  });

  it("refuses admins with 403 on every endpoint", async () => {
    const admin = await createAccount({ role: "ADMIN" });
    const headers = await getAuthHeaders(admin);
    const phoneNumber = bdNumber();

    const status = await inject({ method: "GET", url: BASE, headers });
    expect(status.statusCode).toBe(403);
    expect(status.json().code).toBe("FORBIDDEN");

    const sendRes = await send(headers, phoneNumber);
    expect(sendRes.statusCode).toBe(403);

    const verifyRes = await verify(headers, phoneNumber, "123456");
    expect(verifyRes.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe("POST /phone-verification/send", () => {
  it("sends a code to the number and returns the expiry and resend time", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const before = Date.now();

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json();
    expect(body.phoneNumber).toBe(phoneNumber);
    const expiresAt = new Date(body.expiresAt).getTime();
    const resendAfter = new Date(body.resendAfter).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 5 * MINUTE - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 5 * MINUTE);
    expect(resendAfter - expiresAt).toBeCloseTo(-4 * MINUTE, -3);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(phoneNumber);
    expect(sent[0].msg).toMatch(
      /^Your Masters Hub code is \d{6}\. It expires in 5 minutes\. Don't share it with anyone\.$/,
    );

    const row = await prisma.phoneOtp.findFirst({ where: { accountId: student.account.id } });
    expect(row).toMatchObject({ phoneNumber, verifiedAt: null, consumedAt: null, attempts: 0 });
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.codeHash).not.toContain(codeFromLastSms());
  });

  it("refuses a number that is not a Bangladeshi mobile with 400", async () => {
    const student = await studentWithProfile();
    for (const phoneNumber of ["+14155550100", "01712345678", "+88015123456789"]) {
      const res = await send(student.headers, phoneNumber);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a number another account uses with 409 PHONE_IN_USE", async () => {
    const phoneNumber = bdNumber();
    await tutorWithProfile({ phoneNumber });
    const student = await studentWithProfile();

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PHONE_IN_USE");
    expect(sent).toHaveLength(0);
  });

  it("refuses a number already verified on my profile with 409", async () => {
    const phoneNumber = bdNumber();
    const student = await studentWithProfile({ phoneNumber });
    await prisma.student.update({
      where: { accountId: student.account.id },
      data: { phoneVerifiedAt: new Date() },
    });

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PHONE_ALREADY_VERIFIED");
    expect(sent).toHaveLength(0);
  });

  it("allows a re-send to my own unverified profile number", async () => {
    const phoneNumber = bdNumber();
    const student = await studentWithProfile({ phoneNumber });
    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(200);
  });

  it("enforces a 60 second cooldown per number with retryAfterSeconds", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    expect((await send(student.headers, phoneNumber)).statusCode).toBe(200);

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("OTP_COOLDOWN");
    const { retryAfterSeconds } = res.json().details;
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(sent).toHaveLength(1);

    // Once the cooldown has passed, another code can go out.
    await ageLatestRow(student.account.id, phoneNumber, 61 * 1000);
    expect((await send(student.headers, phoneNumber)).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("caps a number at 5 codes per rolling hour across accounts", async () => {
    const phoneNumber = bdNumber();
    for (let i = 0; i < 5; i++) {
      const other = await createAccount({ role: "STUDENT" });
      await prisma.phoneOtp.create({
        data: {
          accountId: other.id,
          phoneNumber,
          codeHash: "x".repeat(64),
          expiresAt: new Date(Date.now() + 5 * MINUTE),
          createdAt: new Date(Date.now() - 10 * MINUTE),
        },
      });
    }
    const student = await studentWithProfile();

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("OTP_SEND_LIMIT");
    expect(sent).toHaveLength(0);
  });

  it("caps an account at 10 codes per rolling hour across numbers", async () => {
    const student = await studentWithProfile();
    for (let i = 0; i < 10; i++) {
      await prisma.phoneOtp.create({
        data: {
          accountId: student.account.id,
          phoneNumber: bdNumber(),
          codeHash: "x".repeat(64),
          expiresAt: new Date(Date.now() + 5 * MINUTE),
          createdAt: new Date(Date.now() - 2 * MINUTE),
        },
      });
    }

    const res = await send(student.headers, bdNumber());
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("OTP_SEND_LIMIT");
    expect(sent).toHaveLength(0);
  });

  it("does not count sends older than an hour", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    for (let i = 0; i < 5; i++) {
      await prisma.phoneOtp.create({
        data: {
          accountId: student.account.id,
          phoneNumber,
          codeHash: "x".repeat(64),
          expiresAt: new Date(Date.now() - HOUR),
          createdAt: new Date(Date.now() - HOUR - 5 * MINUTE),
        },
      });
    }

    expect((await send(student.headers, phoneNumber)).statusCode).toBe(200);
  });

  it("expires the row and rethrows when the SMS fails, and the failed send still cools down", async () => {
    setSmsSenderForTests(async () => {
      throw appError(
        "SmsUnavailable",
        503,
        "We couldn't send the SMS. Try again in a few minutes.",
      );
    });
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();

    const res = await send(student.headers, phoneNumber);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("SMS_UNAVAILABLE");

    const row = await prisma.phoneOtp.findFirst({ where: { accountId: student.account.id } });
    expect(row).not.toBeNull();
    expect(row?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    const again = await send(student.headers, phoneNumber);
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe("OTP_COOLDOWN");
  });

  it("keeps the earlier code valid when a resend's SMS fails", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, phoneNumber);
    await ageLatestRow(student.account.id, phoneNumber, 61 * 1000);

    setSmsSenderForTests(async () => {
      throw appError(
        "SmsUnavailable",
        503,
        "We couldn't send the SMS. Try again in a few minutes.",
      );
    });
    const failed = await send(student.headers, phoneNumber);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe("SMS_UNAVAILABLE");
    expect(sent).toHaveLength(1);

    // The first code never expired: the failed resend only expired its own row.
    const res = await verify(student.headers, phoneNumber, code);
    expect(res.statusCode).toBe(200);
    expect(res.json().phoneNumber).toBe(phoneNumber);
  });

  it("expires the earlier code only after the new SMS goes out", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const firstCode = await sendAndReadCode(student.headers, phoneNumber);
    await ageLatestRow(student.account.id, phoneNumber, 61 * 1000);

    expect((await send(student.headers, phoneNumber)).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
    const secondCode = codeFromLastSms();

    // The first row is expired now, so the latest live code is the second one.
    const stale = await verify(student.headers, phoneNumber, firstCode);
    expect(stale.statusCode).toBe(400);
    expect(stale.json().code).toBe("OTP_INVALID");

    const fresh = await verify(student.headers, phoneNumber, secondCode);
    expect(fresh.statusCode).toBe(200);
  });
});

describe("POST /phone-verification/verify", () => {
  it("rejects a wrong code with attemptsLeft going down", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, phoneNumber);

    const first = await verify(student.headers, phoneNumber, wrongCode(code));
    expect(first.statusCode).toBe(400);
    expect(first.json()).toMatchObject({ code: "OTP_INVALID", details: { attemptsLeft: 4 } });

    const second = await verify(student.headers, phoneNumber, wrongCode(code));
    expect(second.json()).toMatchObject({ code: "OTP_INVALID", details: { attemptsLeft: 3 } });
  });

  it("locks the code after 5 wrong guesses, even when the right one follows", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, phoneNumber);

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await verify(student.headers, phoneNumber, wrongCode(code));
      expect(res.statusCode).toBe(400);
      expect(res.json().details.attemptsLeft).toBe(5 - attempt);
    }

    const locked = await verify(student.headers, phoneNumber, code);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("OTP_TOO_MANY_ATTEMPTS");
  });

  it("reports an expired code with OTP_EXPIRED", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, phoneNumber);

    await prisma.phoneOtp.updateMany({
      where: { accountId: student.account.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await verify(student.headers, phoneNumber, code);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("OTP_EXPIRED");
  });

  it("reports OTP_EXPIRED when no code was sent to the number", async () => {
    const student = await studentWithProfile();
    const res = await verify(student.headers, bdNumber(), "123456");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("OTP_EXPIRED");
  });

  it("reports OTP_EXPIRED, not OTP_INVALID, for a code whose SMS failed", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    setSmsSenderForTests(async () => {
      throw appError(
        "SmsUnavailable",
        503,
        "We couldn't send the SMS. Try again in a few minutes.",
      );
    });
    const failed = await send(student.headers, phoneNumber);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe("SMS_UNAVAILABLE");

    // The user never received a code, so whatever they type cannot be a wrong guess.
    const res = await verify(student.headers, phoneNumber, "123456");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("OTP_EXPIRED");
  });

  it("sets the profile's verifiedAt and changes its number when it differs", async () => {
    const student = await studentWithProfile({ phoneNumber: bdNumber() });
    const newNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, newNumber);

    const res = await verify(student.headers, newNumber, code);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.json();
    expect(body.phoneNumber).toBe(newNumber);

    const profile = await prisma.student.findUnique({ where: { accountId: student.account.id } });
    expect(profile?.phoneNumber).toBe(newNumber);
    expect(profile?.phoneVerifiedAt?.toISOString()).toBe(body.verifiedAt);

    const row = await prisma.phoneOtp.findFirst({ where: { accountId: student.account.id } });
    expect(row?.verifiedAt?.toISOString()).toBe(body.verifiedAt);
    expect(row?.consumedAt?.toISOString()).toBe(body.verifiedAt);

    // The same code cannot be used twice.
    const replay = await verify(student.headers, newNumber, code);
    expect(replay.json().code).toBe("OTP_EXPIRED");
  });

  it("marks a tutor's profile verified", async () => {
    const tutor = await tutorWithProfile({ phoneNumber: bdNumber() });
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(tutor.headers, phoneNumber);

    const res = await verify(tutor.headers, phoneNumber, code);
    expect(res.statusCode).toBe(200);
    const profile = await prisma.tutor.findUnique({ where: { accountId: tutor.account.id } });
    expect(profile).toMatchObject({ phoneNumber });
    expect(profile?.phoneVerifiedAt).not.toBeNull();
  });

  it("leaves the code unconsumed when there is no profile yet", async () => {
    const account = await createAccount({ role: "STUDENT" });
    const headers = await getAuthHeaders(account);
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(headers, phoneNumber);

    const res = await verify(headers, phoneNumber, code);
    expect(res.statusCode).toBe(200);
    expect(res.json().phoneNumber).toBe(phoneNumber);

    const row = await prisma.phoneOtp.findFirst({ where: { accountId: account.id } });
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.consumedAt).toBeNull();
  });

  it("reports PHONE_IN_USE when another account takes the number after the code was sent", async () => {
    const student = await studentWithProfile();
    const phoneNumber = bdNumber();
    const code = await sendAndReadCode(student.headers, phoneNumber);
    await tutorWithProfile({ phoneNumber });

    const res = await verify(student.headers, phoneNumber, code);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PHONE_IN_USE");
  });
});

describe("profile phone changes reset verification", () => {
  it("clears phoneVerifiedAt when PATCH changes the student's number", async () => {
    const student = await studentWithProfile({ phoneNumber: bdNumber() });
    await prisma.student.update({
      where: { accountId: student.account.id },
      data: { phoneVerifiedAt: new Date() },
    });

    const res = await inject({
      method: "PATCH",
      url: "/api/v1/students/me",
      headers: student.headers,
      payload: { phoneNumber: bdNumber() },
    });
    expect(res.statusCode).toBe(200);

    const profile = await prisma.student.findUnique({ where: { accountId: student.account.id } });
    expect(profile?.phoneVerifiedAt).toBeNull();
  });

  it("keeps phoneVerifiedAt when PATCH sends the same number", async () => {
    const phoneNumber = bdNumber();
    const student = await studentWithProfile({ phoneNumber });
    const verifiedAt = new Date("2026-11-19T10:00:00.000Z");
    await prisma.student.update({
      where: { accountId: student.account.id },
      data: { phoneVerifiedAt: verifiedAt },
    });

    const res = await inject({
      method: "PATCH",
      url: "/api/v1/students/me",
      headers: student.headers,
      payload: { phoneNumber },
    });
    expect(res.statusCode).toBe(200);

    const profile = await prisma.student.findUnique({ where: { accountId: student.account.id } });
    expect(profile?.phoneVerifiedAt?.toISOString()).toBe(verifiedAt.toISOString());
  });
});

// The HTTP auth check already refuses blocked accounts, so these call the service directly.
describe("blocked accounts", () => {
  it("refuses to send or verify a code for a non-active account with 403", async () => {
    const account = await createAccount({ role: "STUDENT", status: "BLOCKED" });
    const caller = { accountId: account.id, role: "STUDENT" as const, email: account.email };
    const phoneNumber = bdNumber();

    await expect(sendPhoneOtp(caller, { phoneNumber })).rejects.toMatchObject({
      statusCode: 403,
      message: "Account is blocked",
    });
    await expect(verifyPhoneOtp(caller, { phoneNumber, code: "123456" })).rejects.toMatchObject({
      statusCode: 403,
      message: "Account is blocked",
    });
    expect(sent).toHaveLength(0);
    expect(await prisma.phoneOtp.count({ where: { accountId: account.id } })).toBe(0);
  });
});
