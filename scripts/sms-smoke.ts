// Checks the SMS provider: prints the account balance, then sends one real SMS only when
// SMS_SMOKE_TO is set (E.164, e.g. +8801712345678). Refuses without SMS_KEY and never sends
// while SMS_DRY_RUN=true. Run: yarn sms:smoke

import { env } from "../src/config/env.js";
import { getSmsBalance, sendSms } from "../src/lib/sms.js";

if (!env.SMS_KEY) {
  console.error("Refusing to run: set SMS_KEY in .env first.");
  process.exit(1);
}

function step(name: string, detail?: string) {
  console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const balance = await getSmsBalance();
  step("balance", balance);

  const to = process.env.SMS_SMOKE_TO?.trim();
  if (!to) {
    step("send", "skipped: set SMS_SMOKE_TO to send one SMS");
    return;
  }
  if (!/^\+8801[3-9]\d{8}$/.test(to)) {
    throw new Error("SMS_SMOKE_TO must be a Bangladeshi mobile number like +8801712345678");
  }
  if (env.SMS_DRY_RUN === "true") {
    step("send", "skipped: SMS_DRY_RUN=true");
    return;
  }

  const { requestId } = await sendSms(
    to,
    "Masters Hub SMS smoke test. You can ignore this message.",
  );
  step("send", requestId ? `request ${requestId}` : "no request id returned");
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("sms smoke: all steps passed");
}
