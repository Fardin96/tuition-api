import { describe, expect, it } from "vitest";
import { r2PublicConfigWarnings } from "./env.js";

const SWAPPED_NAME =
  "R2_BUCKET_PUBLIC is set; did you mean R2_PUBLIC_BUCKET? Public media stays on signed links until it is set.";
const ONE_OF_PAIR =
  "Only one of R2_PUBLIC_BUCKET and R2_PUBLIC_URL_PREFIX is set. Public media stays on signed links until both are set.";

describe("r2PublicConfigWarnings", () => {
  it("is silent when no public R2 setting is present", () => {
    expect(r2PublicConfigWarnings({})).toEqual([]);
  });

  it("is silent when both public settings are set", () => {
    expect(
      r2PublicConfigWarnings({
        R2_PUBLIC_BUCKET: "media-public",
        R2_PUBLIC_URL_PREFIX: "https://media.example.test",
      }),
    ).toEqual([]);
  });

  it("warns when R2_BUCKET_PUBLIC is set and R2_PUBLIC_BUCKET is not", () => {
    expect(r2PublicConfigWarnings({ R2_BUCKET_PUBLIC: "media-public" })).toEqual([SWAPPED_NAME]);
  });

  it("warns when only R2_PUBLIC_URL_PREFIX is set", () => {
    expect(r2PublicConfigWarnings({ R2_PUBLIC_URL_PREFIX: "https://media.example.test" })).toEqual([
      ONE_OF_PAIR,
    ]);
  });

  it("warns when only R2_PUBLIC_BUCKET is set", () => {
    expect(r2PublicConfigWarnings({ R2_PUBLIC_BUCKET: "media-public" })).toEqual([ONE_OF_PAIR]);
  });

  it("treats an empty value as unset, as storage does", () => {
    expect(
      r2PublicConfigWarnings({
        R2_BUCKET_PUBLIC: "",
        R2_PUBLIC_BUCKET: "",
        R2_PUBLIC_URL_PREFIX: "",
      }),
    ).toEqual([]);
    expect(
      r2PublicConfigWarnings({ R2_PUBLIC_BUCKET: "media-public", R2_PUBLIC_URL_PREFIX: "" }),
    ).toEqual([ONE_OF_PAIR]);
  });

  it("never puts a value in a message", () => {
    const messages = r2PublicConfigWarnings({
      R2_BUCKET_PUBLIC: "bucket-value-7f3a",
      R2_PUBLIC_URL_PREFIX: "https://cdn-value-9d2e.example.test",
    });

    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toContain("value-7f3a");
      expect(message).not.toContain("value-9d2e");
    }
  });
});
