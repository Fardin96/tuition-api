import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSmsBalance, sendSms, setSmsSenderForTests } from "./sms.js";

// Mutable copy of env so each test can pick its mode (dry run, live, production) without a reload.
const smsEnv = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/env.js")>();
  Object.assign(smsEnv, actual.env);
  return { env: smsEnv };
});

const LIVE = {
  NODE_ENV: "development",
  SMS_KEY: "test-key",
  SMS_BASE_URL: "https://sms.example.test",
  SMS_DRY_RUN: undefined,
};

const fetchMock = vi.fn();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sentForm(call = 0): URLSearchParams {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return init.body as URLSearchParams;
}

async function sendError(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected sendSms to reject");
    },
    (err: unknown) => err as Record<string, unknown>,
  );
}

beforeEach(() => {
  Object.assign(smsEnv, LIVE);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  setSmsSenderForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendSms", () => {
  it("posts a form body, strips the plus and never sends sender_id", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 0, msg: "ok", data: { request_id: 42 } }));

    const result = await sendSms("+8801712345678", "Your code is 123456");

    expect(result).toEqual({ requestId: "42" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sms.example.test/sendsms");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const form = sentForm();
    expect(form.get("api_key")).toBe("test-key");
    expect(form.get("msg")).toBe("Your code is 123456");
    expect(form.get("to")).toBe("8801712345678");
    expect(form.has("sender_id")).toBe(false);
  });

  it("treats a string error of 0 as success", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: "0", msg: "ok" }));

    await expect(sendSms("+8801712345678", "hi")).resolves.toEqual({ requestId: null });
  });

  it("treats null and blank error values as failures, not success", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: null, msg: "" }));
    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      name: "SmsUnavailable",
    });

    fetchMock.mockResolvedValueOnce(reply({ error: "  ", msg: "" }));
    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      name: "SmsUnavailable",
    });
  });

  it("maps a numeric 417 to 503 SMS_UNAVAILABLE and logs it as an account problem", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 417, msg: "Insufficient balance" }));

    const err = await sendError(sendSms("+8801712345678", "hi"));

    expect(err).toMatchObject({
      name: "SmsUnavailable",
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
      message: "We couldn't send the SMS. Try again in a few minutes.",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention: code 417 Insufficient balance"),
    );
  });

  it("logs 421 (trial account, registered number only) as an account problem", async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ error: 421, msg: "Please recharge or send SMS to your registered number only." }),
    );

    const err = await sendError(sendSms("+8801712345678", "hi"));

    expect(err).toMatchObject({ statusCode: 503, code: "SMS_UNAVAILABLE" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention: code 421"),
    );
  });

  it("maps a string 417 the same way", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: "417", msg: "Insufficient balance" }));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention"),
    );
  });

  it("logs 410 and 411 with the account prefix too", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 410, msg: "Account expired" }));
    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({ statusCode: 503 });

    fetchMock.mockResolvedValueOnce(reply({ error: "411", msg: "Reseller suspended" }));
    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({ statusCode: 503 });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention: code 410"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention: code 411"),
    );
  });

  it("maps a numeric 416 to 400 with the friendly message", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 416, msg: "No valid number" }));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      name: "ValidationError",
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "This number can't receive SMS.",
    });
  });

  it("maps a string 416 to 400 as well", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: "416", msg: "No valid number" }));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      statusCode: 400,
      message: "This number can't receive SMS.",
    });
  });

  it("maps other provider codes to 503 without the account prefix", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 420, msg: "Content blocked" }));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("provider error code 420 Content blocked"),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SMS account needs attention"),
    );
  });

  it("maps a timeout to 503", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
    });
  });

  it("maps a network error to 503 and does not log the key or the message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(sendSms("+8801712345678", "Your code is 987654")).rejects.toMatchObject({
      statusCode: 503,
    });

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain("987654");
  });

  it("maps an unreadable response to 503", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("throws 503 without calling the provider when no key is set outside development", async () => {
    Object.assign(smsEnv, { NODE_ENV: "production", SMS_KEY: undefined });

    await expect(sendSms("+8801712345678", "hi")).rejects.toMatchObject({
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry runs under NODE_ENV=test and hands the message to the test sender", async () => {
    Object.assign(smsEnv, { NODE_ENV: "test" });
    const sender = vi.fn(async () => {});
    setSmsSenderForTests(sender);

    await expect(sendSms("+8801712345678", "Your code is 111222")).resolves.toEqual({
      requestId: null,
    });

    expect(sender).toHaveBeenCalledWith("+8801712345678", "Your code is 111222");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry runs with SMS_DRY_RUN=true even with a key, using the test sender", async () => {
    Object.assign(smsEnv, { SMS_DRY_RUN: "true" });
    const sender = vi.fn(async () => {});
    setSmsSenderForTests(sender);

    await sendSms("+8801712345678", "hi");

    expect(sender).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry runs without a test sender by logging in development only", async () => {
    Object.assign(smsEnv, { SMS_DRY_RUN: "true" });

    await sendSms("+8801712345678", "hi");
    expect(console.info).toHaveBeenCalledWith("[sms:dry-run]", "+8801712345678", "hi");

    vi.mocked(console.info).mockClear();
    Object.assign(smsEnv, { NODE_ENV: "test" });
    await sendSms("+8801712345678", "hi");
    expect(console.info).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry runs in development when there is no key", async () => {
    Object.assign(smsEnv, { SMS_KEY: undefined });

    await expect(sendSms("+8801712345678", "hi")).resolves.toEqual({ requestId: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getSmsBalance", () => {
  it("returns the balance string", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 0, msg: "ok", data: { balance: "12.3400" } }));

    await expect(getSmsBalance()).resolves.toBe("12.3400");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sms.example.test/user/balance/?api_key=test-key");
    expect(init.method).toBe("GET");
  });

  it("maps a provider error to 503", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 405, msg: "Auth required" }));

    await expect(getSmsBalance()).rejects.toMatchObject({
      statusCode: 503,
      code: "SMS_UNAVAILABLE",
    });
  });

  it("maps a network error to 503 without leaking the key", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const err = await sendError(getSmsBalance());

    expect(err).toMatchObject({ statusCode: 503 });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("test-key");
  });
});
