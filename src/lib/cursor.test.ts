import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ID = "0190f3a2-7c1d-7e4f-8a2b-3c4d5e6f7a8b";

function raw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected decodeCursor to throw");
}

describe("cursor", () => {
  it("round-trips createdAt and a uuid id", () => {
    const createdAt = new Date("2026-11-01T10:00:00.000Z");
    expect(decodeCursor(encodeCursor({ createdAt, id: ID }))).toEqual({ createdAt, id: ID });
  });

  it("answers 400 VALIDATION_ERROR for input that is not base64 JSON", () => {
    expect(thrownBy(() => decodeCursor("garbage"))).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Invalid cursor",
    });
    expect(thrownBy(() => decodeCursor("%%%"))).toMatchObject({ statusCode: 400 });
  });

  it("answers 400 VALIDATION_ERROR for a bad date", () => {
    expect(thrownBy(() => decodeCursor(raw(["not-a-date", ID])))).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it.each([
    ["a non-uuid string", "not-a-uuid"],
    ["an integer", 42],
    ["an empty string", ""],
    ["a uuid with a stray character", `${ID}x`],
  ])("answers 400 VALIDATION_ERROR for an id that is %s", (_label, id) => {
    expect(thrownBy(() => decodeCursor(raw(["2026-11-01T10:00:00.000Z", id])))).toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
    });
  });
});
