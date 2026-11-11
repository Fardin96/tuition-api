import { describe, expect, it } from "vitest";
import { buildApp } from "../server.js";

describe("BigInt serialisation", () => {
  it("serialises BigInt values to strings in JSON.stringify once the server module is loaded", () => {
    expect(JSON.stringify({ id: 1n })).toBe('{"id":"1"}');
  });

  it("responds with a BigInt field as a string", async () => {
    const app = await buildApp();
    app.get("/bigint-probe", async () => ({ id: 1n }));

    const res = await app.inject({ method: "GET", url: "/bigint-probe" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: "1" });
  });
});
