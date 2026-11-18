import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

export interface ObjectStorage {
  /** Signed PUT to the private bucket. The browser must send the same Content-Type. */
  presignPut(input: { key: string; contentType: string; expiresIn: number }): Promise<string>;
  /** Signed GET from the private bucket. */
  presignGet(input: { key: string; expiresIn: number; fileName?: string | null }): Promise<string>;
  /** Size and type of a private object, or null when it does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** The first `bytes` bytes of a private object (for type sniffing). */
  readStart(key: string, bytes: number): Promise<Uint8Array>;
  /** Deletes from the private bucket, or the public one. A missing object is not an error. */
  delete(key: string, bucket?: "private" | "public"): Promise<void>;
  /** Copies a private object to the public bucket. Only call when publicUrl(key) is not null. */
  copyToPublic(key: string): Promise<void>;
  /** Stable public URL for a published key, or null when no public bucket is configured. */
  publicUrl(key: string): string | null;
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

// RFC 6266 filename: strip quotes and control characters, keep it short.
function dispositionName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, "").slice(0, 120);
}

function createR2Storage(): ObjectStorage {
  const privateBucket = env.R2_BUCKET as string;
  const publicBucket =
    env.R2_PUBLIC_BUCKET && env.R2_PUBLIC_URL_PREFIX ? env.R2_PUBLIC_BUCKET : null;
  const publicPrefix = (env.R2_PUBLIC_URL_PREFIX ?? "").replace(/\/+$/, "");

  const client = new S3Client({
    region: env.R2_REGION || "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    },
  });

  return {
    presignPut: ({ key, contentType, expiresIn }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: privateBucket, Key: key, ContentType: contentType }),
        { expiresIn },
      ),

    presignGet: ({ key, expiresIn, fileName }) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: privateBucket,
          Key: key,
          ...(fileName
            ? { ResponseContentDisposition: `inline; filename="${dispositionName(fileName)}"` }
            : {}),
        }),
        { expiresIn },
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
      const source = `${privateBucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
      await client.send(
        new CopyObjectCommand({ Bucket: publicBucket, Key: key, CopySource: source }),
      );
    },

    publicUrl: (key) => (publicBucket ? `${publicPrefix}/${key}` : null),
  };
}
