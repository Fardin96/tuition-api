import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { env } from "./config/env.js";
import { appError, ERROR_CODES, type ErrorName, errorCodeOf } from "./lib/errors.js";
import {
  createAccount,
  createArea,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "./tests/helpers.js";

const STATUS_BY_NAME: Partial<Record<ErrorName, number>> = {
  ValidationError: 400,
  InvalidRequirement: 400,
  InvalidSubjectOrZone: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  RateLimited: 429,
  InternalError: 500,
  NotImplemented: 501,
};

describe("error handler", () => {
  const nodeEnv = env.NODE_ENV;
  afterEach(() => {
    env.NODE_ENV = nodeEnv;
  });

  it("masks unexpected errors in production", async () => {
    const app = await createTestApp();
    app.get("/boom", async () => {
      throw new Error("secret detail");
    });
    env.NODE_ENV = "production";

    const res = await app.inject({ method: "GET", url: "/boom" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: "Error",
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
  });

  it("keeps the message of 4xx errors in production", async () => {
    const app = await createTestApp();
    const area = await createArea();
    const taken = `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const tutor = await createAccount({ role: "TUTOR" });
    await createTutorProfile(tutor.id, { phoneNumber: taken });
    const account = await createAccount({ role: "STUDENT" });
    const headers = await getAuthHeaders(account);
    env.NODE_ENV = "production";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/students/me",
      headers,
      payload: {
        name: "Student Name",
        areaId: area.id,
        address: "Student Address",
        emergencyContact: "+8801700000001",
        whatsappNumber: `+88018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        studentIdNumber: `STU-${crypto.randomUUID()}`,
        phoneNumber: taken,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.message).toBe("This phone number is already in use.");
    expect(body.code).toBe("PHONE_IN_USE");
    expect(body.error).toBe("PhoneInUse");
  });

  it.each(Object.entries(ERROR_CODES))("renders %s with code %s", async (name, code) => {
    const app = await createTestApp();
    const status = STATUS_BY_NAME[name as ErrorName] ?? 409;
    const url = `/err/${name}`;
    app.get(url, async () => {
      throw appError(name as ErrorName, status, "msg", { ids: ["x"] });
    });

    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({
      error: name,
      code,
      message: "msg",
      details: { ids: ["x"] },
    });
  });

  it("does not leak foreign error codes from plain errors", async () => {
    const app = await createTestApp();
    app.get("/foreign-code", async () => {
      throw Object.assign(new Error("db boom"), { code: "P2002" });
    });

    const res = await app.inject({ method: "GET", url: "/foreign-code" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: "Error",
      code: "INTERNAL_ERROR",
      message: "db boom",
    });
  });

  it("maps a plain rate-limit object to RateLimited", async () => {
    const app = await createTestApp();
    app.get("/rate-limited", async () => {
      throw { statusCode: 429, message: "Too many requests" };
    });

    const res = await app.inject({ method: "GET", url: "/rate-limited" });

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({
      error: "RateLimited",
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
  });

  it("drops details and the message of 500 errors in production", async () => {
    const app = await createTestApp();
    app.get("/masked-details", async () => {
      throw appError("InternalError", 500, "secret", { a: 1 });
    });
    env.NODE_ENV = "production";

    const res = await app.inject({ method: "GET", url: "/masked-details" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: "InternalError",
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
  });

  it("renders zod body validation failures as ValidationError with issues", async () => {
    const app = await createTestApp();
    app.post(
      "/zod",
      {
        schema: {
          body: z.object({
            subjectIds: z.array(z.number()).min(1, "At least one subject is required"),
          }),
        },
      },
      async () => ({ ok: true }),
    );

    const res = await app.inject({ method: "POST", url: "/zod", payload: { subjectIds: [] } });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("ValidationError");
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.issues).toEqual([
      { path: ["subjectIds"], message: "At least one subject is required" },
    ]);
  });
});

describe("errorCodeOf", () => {
  it("passes through a known catalogue code", () => {
    expect(errorCodeOf({ code: "PHONE_IN_USE", name: "Error", statusCode: 500 })).toBe(
      "PHONE_IN_USE",
    );
  });

  it("looks up the code by error name when code is missing", () => {
    expect(errorCodeOf({ name: "PhoneInUse" })).toBe("PHONE_IN_USE");
  });

  it("falls back to the status for foreign codes", () => {
    expect(errorCodeOf({ code: "FST_ERR_X", statusCode: 404 })).toBe("NOT_FOUND");
  });
});
