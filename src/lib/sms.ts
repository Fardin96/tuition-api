import { env } from "../config/env.js";
import { appError } from "./errors.js";

// sms.net.bd. Non-masking: we never send sender_id, so messages go out with the provider's default sender.
// No retries: a retry could send the same code twice, and the OTP service already limits sends.

const TIMEOUT_MS = 10_000;
// Codes that mean the account itself needs someone to act (top up, renew), not a bad request.
// 421 is undocumented: an unrecharged (trial) account may only text its own registered number.
const ACCOUNT_CODES = new Set([410, 411, 417, 421]);

type SmsSender = (to: string, msg: string) => Promise<void>;

let testSender: SmsSender | null = null;

export function setSmsSenderForTests(fn: SmsSender | null): void {
  testSender = fn;
}

type ProviderBody = { error?: unknown; msg?: unknown; data?: unknown };

function isDryRun(): boolean {
  if (env.NODE_ENV === "test") return true;
  if (env.SMS_DRY_RUN === "true") return true;
  return !env.SMS_KEY && env.NODE_ENV !== "production";
}

function unavailable(): Error {
  return appError("SmsUnavailable", 503, "We couldn't send the SMS. Try again in a few minutes.");
}

// Only a number or a non-blank string counts as a code, so null, "" and [] never read as 0 (success).
function providerCode(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function requireKey(): string {
  if (!env.SMS_KEY) {
    console.error("[sms] SMS_KEY is not set; SMS cannot be sent");
    throw unavailable();
  }
  return env.SMS_KEY;
}

// Reads the provider's JSON answer. Network, timeout and bad JSON all mean the outcome is unknown.
async function readBody(response: Response): Promise<ProviderBody> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") return body as ProviderBody;
  } catch {
    // Fall through to the shared failure below.
  }
  console.error("[sms] provider sent an unreadable response");
  throw unavailable();
}

async function fetchProvider(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Log the error name only: the message may echo the URL, which carries the key on balance calls.
    console.error("[sms] request failed", err instanceof Error ? err.name : "unknown");
    throw unavailable();
  }
}

/**
 * Sends one SMS. `to` is E.164 (+8801...); the provider wants the digits only.
 * Dry run (NODE_ENV=test, SMS_DRY_RUN=true, or no key outside production) sends nothing:
 * the test sender gets the message if one is installed, else development logs it.
 */
export async function sendSms(to: string, msg: string): Promise<{ requestId: string | null }> {
  if (isDryRun()) {
    if (testSender) {
      await testSender(to, msg);
    } else if (env.NODE_ENV === "development") {
      console.info("[sms:dry-run]", to, msg);
    }
    return { requestId: null };
  }

  const apiKey = requireKey();
  const response = await fetchProvider(`${env.SMS_BASE_URL}/sendsms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ api_key: apiKey, msg, to: to.replace(/^\+/, "") }),
  });
  const body = await readBody(response);
  const code = providerCode(body.error);

  if (code === 0) {
    const requestId = (body.data as { request_id?: unknown } | undefined)?.request_id;
    return { requestId: requestId == null ? null : String(requestId) };
  }

  // The message body is never logged; the provider's own text is.
  const providerMessage = typeof body.msg === "string" ? body.msg : "";
  if (code === 416) {
    throw appError("ValidationError", 400, "This number can't receive SMS.");
  }
  if (ACCOUNT_CODES.has(code)) {
    console.error(`[sms] SMS account needs attention: code ${code} ${providerMessage}`);
  } else {
    console.error(
      `[sms] provider error code ${Number.isNaN(code) ? "unknown" : code} ${providerMessage}`,
    );
  }
  throw unavailable();
}

/** The account balance as the provider reports it, e.g. "12.3400". */
export async function getSmsBalance(): Promise<string> {
  const apiKey = requireKey();
  const query = new URLSearchParams({ api_key: apiKey });
  const response = await fetchProvider(`${env.SMS_BASE_URL}/user/balance/?${query}`, {
    method: "GET",
  });
  const body = await readBody(response);
  const code = providerCode(body.error);
  const balance = (body.data as { balance?: unknown } | undefined)?.balance;
  if (code === 0 && typeof balance === "string") return balance;

  const providerMessage = typeof body.msg === "string" ? body.msg : "";
  console.error(
    `[sms] balance check failed: code ${Number.isNaN(code) ? "unknown" : code} ${providerMessage}`,
  );
  throw unavailable();
}
