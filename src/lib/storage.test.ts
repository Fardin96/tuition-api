import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createR2Storage,
  PUBLIC_MEDIA_CACHE_CONTROL,
  type R2Config,
  stableSigning,
} from "./storage.js";

const config: R2Config = {
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_REGION: "auto",
  R2_BUCKET: "private-bucket",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_PUBLIC_BUCKET: "public-bucket",
  R2_PUBLIC_URL_PREFIX: "https://media.example.test/",
};

const KEY = "TUTOR_VIDEO/tutor-1/9f8c.mp4";

type Sent = { command: unknown; input: Record<string, unknown> };

// Stubs S3Client.send: records each command and answers it with `reply`. No request leaves the test.
function stubS3(reply: (command: unknown) => object = () => ({})): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
    sent.push({ command, input: (command as { input: Record<string, unknown> }).input });
    return reply(command);
  }) as never);
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("copyToPublic", () => {
  it("reads the source type, then copies with REPLACE, that type and the public cache header", async () => {
    const sent = stubS3((command) =>
      command instanceof HeadObjectCommand ? { ContentType: "video/mp4" } : {},
    );

    await createR2Storage(config).copyToPublic(KEY);

    expect(sent.map((call) => call.command instanceof HeadObjectCommand)).toEqual([true, false]);
    expect(sent[0]?.input).toEqual({ Bucket: "private-bucket", Key: KEY });
    expect(sent[1]?.command).toBeInstanceOf(CopyObjectCommand);
    expect(sent[1]?.input).toEqual({
      Bucket: "public-bucket",
      Key: KEY,
      CopySource: "private-bucket/TUTOR_VIDEO/tutor-1/9f8c.mp4",
      MetadataDirective: "REPLACE",
      ContentType: "video/mp4",
      CacheControl: "public, max-age=604800, immutable",
    });
  });

  it("uses the 7-day public cache header", () => {
    expect(PUBLIC_MEDIA_CACHE_CONTROL).toBe("public, max-age=604800, immutable");
  });

  it("keeps the default type S3 reports when the source has none", async () => {
    const sent = stubS3();

    await createR2Storage(config).copyToPublic(KEY);

    expect(sent[1]?.input.ContentType).toBe("application/octet-stream");
  });

  it("encodes each path segment of the copy source", async () => {
    const sent = stubS3((command) =>
      command instanceof HeadObjectCommand ? { ContentType: "image/png" } : {},
    );

    await createR2Storage(config).copyToPublic("STORY_IMAGE/owner/my photo.png");

    expect(sent[1]?.input.CopySource).toBe("private-bucket/STORY_IMAGE/owner/my%20photo.png");
  });

  it("does nothing without a public bucket", async () => {
    const sent = stubS3();

    await createR2Storage({ ...config, R2_PUBLIC_BUCKET: undefined }).copyToPublic(KEY);

    expect(sent).toEqual([]);
  });
});

describe("applyPublicCacheControl and publicKeys", () => {
  it("copies a public object onto itself with its own type and the public cache header", async () => {
    const sent = stubS3((command) =>
      command instanceof HeadObjectCommand ? { ContentType: "image/webp" } : {},
    );

    await createR2Storage(config).applyPublicCacheControl(KEY);

    expect(sent[0]?.input).toEqual({ Bucket: "public-bucket", Key: KEY });
    expect(sent[1]?.input).toEqual({
      Bucket: "public-bucket",
      Key: KEY,
      CopySource: "public-bucket/TUTOR_VIDEO/tutor-1/9f8c.mp4",
      MetadataDirective: "REPLACE",
      ContentType: "image/webp",
      CacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
    });
  });

  it("pages through ListObjectsV2 with the continuation token", async () => {
    const sent = stubS3((command) => {
      if (!(command instanceof ListObjectsV2Command)) return {};
      return command.input.ContinuationToken
        ? { Contents: [{ Key: "b.png" }], IsTruncated: false }
        : { Contents: [{ Key: "a.png" }], IsTruncated: true, NextContinuationToken: "page-2" };
    });

    const keys: string[] = [];
    for await (const key of createR2Storage(config).publicKeys()) keys.push(key);

    expect(keys).toEqual(["a.png", "b.png"]);
    expect(sent.map((call) => call.input)).toEqual([
      { Bucket: "public-bucket", ContinuationToken: undefined },
      { Bucket: "public-bucket", ContinuationToken: "page-2" },
    ]);
  });
});

describe("presignGet", () => {
  // 10:17:42 falls in the window that starts at 10:00:00.
  const ISSUED = "2026-11-22T10:17:42Z";

  function paramsOf(url: string) {
    return new URL(url).searchParams;
  }

  // X-Amz-Date (20261122T100000Z) as a timestamp in ms.
  function amzDateMs(value: string | null): number {
    const iso = (value ?? "").replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      "$1-$2-$3T$4:$5:$6Z",
    );
    return Date.parse(iso);
  }

  function useClock(iso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  }

  it("signs at the window start, expires window + ttl later, and sets the browser cache to the ttl", async () => {
    useClock(ISSUED);

    const url = await createR2Storage(config).presignGet({
      key: KEY,
      expiresIn: 3600,
      stableWindowSeconds: 1800,
    });

    const params = paramsOf(url);
    expect(params.get("X-Amz-Date")).toBe("20261122T100000Z");
    expect(params.get("X-Amz-Expires")).toBe("5400");
    expect(params.get("response-cache-control")).toBe("private, max-age=3600");
  });

  it("returns identical URLs inside one window and a new URL in the next", async () => {
    const storage = createR2Storage(config);
    const sign = (iso: string) => {
      vi.setSystemTime(new Date(iso));
      return storage.presignGet({ key: KEY, expiresIn: 3600, stableWindowSeconds: 1800 });
    };
    useClock("2026-11-22T10:00:00Z");

    const first = await sign("2026-11-22T10:00:00Z");
    const second = await sign("2026-11-22T10:17:42Z");
    const last = await sign("2026-11-22T10:29:59Z");
    const next = await sign("2026-11-22T10:30:00Z");

    expect(second).toBe(first);
    expect(last).toBe(first);
    expect(next).not.toBe(first);
    expect(paramsOf(next).get("X-Amz-Date")).toBe("20261122T103000Z");
  });

  it("keeps every link valid for at least the ttl after it is issued", async () => {
    const storage = createR2Storage(config);
    useClock("2026-11-22T10:00:00Z");

    for (const iso of ["2026-11-22T10:00:00Z", "2026-11-22T10:29:59Z"]) {
      vi.setSystemTime(new Date(iso));
      const url = await storage.presignGet({
        key: KEY,
        expiresIn: 3600,
        stableWindowSeconds: 1800,
      });
      const params = paramsOf(url);
      // The expiry a reader computes from the URL itself, as the web app's signedUrlExpired does.
      const expiresAt =
        amzDateMs(params.get("X-Amz-Date")) + Number(params.get("X-Amz-Expires")) * 1000;

      expect(expiresAt).toBe(Date.parse("2026-11-22T11:30:00Z"));
      expect(expiresAt - Date.parse(iso)).toBeGreaterThanOrEqual(3600 * 1000);
    }
  });

  it("without a window signs from now for expiresIn and sends no response cache header", async () => {
    const storage = createR2Storage(config);
    useClock(ISSUED);
    const first = await storage.presignGet({ key: KEY, expiresIn: 300, fileName: "a.pdf" });

    const params = paramsOf(first);
    expect(params.get("X-Amz-Date")).toBe("20261122T101742Z");
    expect(params.get("X-Amz-Expires")).toBe("300");
    expect(params.has("response-cache-control")).toBe(false);

    vi.setSystemTime(new Date("2026-11-22T10:18:42Z"));
    const later = await storage.presignGet({ key: KEY, expiresIn: 300 });
    expect(later).not.toBe(first);
  });
});

describe("stableSigning", () => {
  it("starts the window at the floor of the current time and adds the window to the ttl", () => {
    const at = Date.parse("2026-11-22T10:17:42Z");

    const signing = stableSigning(1800, 3600, at);

    expect(signing.signingDate.toISOString()).toBe("2026-11-22T10:00:00.000Z");
    expect(signing.expiresIn).toBe(5400);
  });
});
