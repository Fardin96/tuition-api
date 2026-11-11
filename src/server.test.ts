import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./config/env.js";
import {
  createAccount,
  createArea,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "./tests/helpers.js";

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
    expect(JSON.parse(res.body)).toEqual({ error: "Error", message: "Internal server error" });
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
    expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
  });
});
