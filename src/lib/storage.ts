import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { appError } from "./errors.js";

// Cloudflare R2 through its S3 API. Every object is uploaded to the private bucket; files that
// may be seen by anyone (approved videos, blog covers) get a copy in the public bucket under the
// same key. This module is the only place that imports the AWS SDK.

export type ObjectHead = { size: number; contentType: string | null };

/**
 * Cache-Control for objects in the public bucket. Keys are unique per upload, so a new file gets
 * a new URL. The age is 7 days, not a year, because a file removed for moderation or withdrawn
 * consent must stop being served from caches within a week.
 */
export const PUBLIC_MEDIA_CACHE_CONTROL = "public, max-age=604800, immutable";

export interface ObjectStorage {
  /**
   * Signed PUT to the private bucket. Content-Type and Content-Length are signed, so R2 refuses
   * (403) a body of another type or size.
   */
  presignPut(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresIn: number;
  }): Promise<string>;
  /**
   * Signed GET from the private bucket. With `stableWindowSeconds` the link is signed at the start
   * of the current window and lives `stableWindowSeconds + expiresIn`, so every link issued inside
   * one window is byte-identical. The browser keeps the response for `expiresIn`. Without it the
   * link lives `expiresIn` from now (download links never use a window).
   */
  presignGet(input: {
    key: string;
    expiresIn: number;
    fileName?: string | null;
    stableWindowSeconds?: number;
  }): Promise<string>;
  /** Size and type of a private object, or null when it does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** The first `bytes` bytes of a private object (for type sniffing). */
  readStart(key: string, bytes: number): Promise<Uint8Array>;
  /** Deletes from the private bucket, or the public one. A missing object is not an error. */
  delete(key: string, bucket?: "private" | "public"): Promise<void>;
  /**
   * Copies a private object to the public bucket with PUBLIC_MEDIA_CACHE_CONTROL. Only call when
   * publicUrl(key) is not null.
   */
  copyToPublic(key: string): Promise<void>;
  /** Stable public URL for a published key, or null when no public bucket is configured. */
  publicUrl(key: string): string | null;
  /** Every key in the public bucket, paging through ListObjectsV2. Empty without a public bucket. */
  publicKeys(): AsyncGenerator<string>;
  /**
   * Rewrites a public object onto itself with PUBLIC_MEDIA_CACHE_CONTROL and its own Content-Type.
   * Used by the backfill script for objects copied before the header existed.
   */
  applyPublicCacheControl(key: string): Promise<void>;
}

/** Whether the public bucket and its URL prefix are both configured. */
export function publicBucketConfigured(): boolean {
  return Boolean(env.R2_PUBLIC_BUCKET && env.R2_PUBLIC_URL_PREFIX);
}

/** Expiry window for stable signed links: sign at the window start, add the window to the TTL. */
export function stableSigning(
  windowSeconds: number,
  expiresIn: number,
  now = Date.now(),
): { signingDate: Date; expiresIn: number } {
  const windowMs = windowSeconds * 1000;
  return {
    signingDate: new Date(Math.floor(now / windowMs) * windowMs),
    expiresIn: windowSeconds + expiresIn,
  };
}

let testStorage: ObjectStorage | null = null;
let realStorage: ObjectStorage | null = null;

export function storageConfigured(): boolean {
  if (testStorage) return true;
  return Boolean(
    env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY,
  );
}

export function setStorageForTests(storage: ObjectStorage | null): void {
  testStorage = storage;
}

/** The configured storage, or 503 STORAGE_UNAVAILABLE. */
export function getStorage(): ObjectStorage {
  if (testStorage) return testStorage;
  if (!storageConfigured()) {
    throw appError("StorageUnavailable", 503, "File uploads are not available right now.");
  }
  realStorage ??= createR2Storage();
  return realStorage;
}

/** The storage when configured, else null. For reads that degrade to "no URL". */
export function maybeStorage(): ObjectStorage | null {
  return storageConfigured() ? getStorage() : null;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * RFC 6266 Content-Disposition for a stored file name: an ASCII `filename` for old clients and
 * an RFC 5987 `filename*` with the real (UTF-8) name. Without `filename*`, non-ASCII names such
 * as Bangla arrive garbled.
 */
export function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .trim() || "file";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The R2 settings createR2Storage reads. */
export type R2Config = Pick<
  typeof env,
  | "R2_ENDPOINT"
  | "R2_REGION"
  | "R2_BUCKET"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_PUBLIC_BUCKET"
  | "R2_PUBLIC_URL_PREFIX"
>;

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createR2Storage(config: R2Config = env): ObjectStorage {
  const privateBucket = config.R2_BUCKET as string;
  const publicBucket =
    config.R2_PUBLIC_BUCKET && config.R2_PUBLIC_URL_PREFIX ? config.R2_PUBLIC_BUCKET : null;
  const publicPrefix = (config.R2_PUBLIC_URL_PREFIX ?? "").replace(/\/+$/, "");

  const client = new S3Client({
    region: config.R2_REGION || "auto",
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID as string,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY as string,
    },
  });

  // Copies an object with the public Cache-Control. REPLACE drops the source's metadata, so its
  // Content-Type is read first and sent again; without it R2 would store binary/octet-stream. An
  // object with no stored type gets the default S3 reports for one.
  async function copyWithPublicCache(sourceBucket: string, destBucket: string, key: string) {
    const head = await client.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }));
    await client.send(
      new CopyObjectCommand({
        Bucket: destBucket,
        Key: key,
        CopySource: `${sourceBucket}/${encodeKey(key)}`,
        MetadataDirective: "REPLACE",
        ContentType: head.ContentType ?? "application/octet-stream",
        CacheControl: PUBLIC_MEDIA_CACHE_CONTROL,
      }),
    );
  }

  return {
    presignPut: ({ key, contentType, contentLength, expiresIn }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: privateBucket,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
        // The presigner leaves content-length unsigned unless asked; R2 enforces it once signed.
        { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) },
      ),

    presignGet: ({ key, expiresIn, fileName, stableWindowSeconds }) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: privateBucket,
          Key: key,
          ...(fileName ? { ResponseContentDisposition: contentDisposition(fileName) } : {}),
          // Stable links only. The browser keeps the response for expiresIn, which the link is
          // guaranteed to outlive.
          ...(stableWindowSeconds ? { ResponseCacheControl: `private, max-age=${expiresIn}` } : {}),
        }),
        stableWindowSeconds ? stableSigning(stableWindowSeconds, expiresIn) : { expiresIn },
      ),

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: privateBucket, Key: key }));
        return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readStart(key, bytes) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: privateBucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
      );
      if (!res.Body) return new Uint8Array();
      return res.Body.transformToByteArray();
    },

    async delete(key, bucket = "private") {
      const target = bucket === "public" ? publicBucket : privateBucket;
      if (!target) return;
      try {
        await client.send(new DeleteObjectCommand({ Bucket: target, Key: key }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async copyToPublic(key) {
      if (!publicBucket) return;
      await copyWithPublicCache(privateBucket, publicBucket, key);
    },

    async *publicKeys() {
      if (!publicBucket) return;
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket: publicBucket, ContinuationToken: token }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) yield obj.Key;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    },

    async applyPublicCacheControl(key) {
      if (!publicBucket) return;
      await copyWithPublicCache(publicBucket, publicBucket, key);
    },

    publicUrl: (key) => (publicBucket ? `${publicPrefix}/${key}` : null),
  };
}
