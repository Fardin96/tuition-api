import type { FilePurpose, Role } from "../../generated/prisma/enums.js";

// What each purpose accepts and who may upload it. The single source for upload limits.

const MB = 1024 * 1024;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const DOCUMENT_TYPES = [...IMAGE_TYPES, "application/pdf"] as const;
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;

export type FilePolicy = {
  role: Role;
  contentTypes: readonly string[];
  maxBytes: number;
};

export const FILE_POLICY: Record<FilePurpose, FilePolicy> = {
  STUDENT_ID: { role: "STUDENT", contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  TUTOR_ID: { role: "TUTOR", contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  CREDENTIAL: { role: "TUTOR", contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  TUTOR_VIDEO: { role: "TUTOR", contentTypes: VIDEO_TYPES, maxBytes: 2 * MB },
  BLOG_COVER: { role: "ADMIN", contentTypes: IMAGE_TYPES, maxBytes: 2 * MB },
};

/** Signed upload URLs live this long (seconds). */
export const UPLOAD_URL_TTL = 10 * 60;
/** Signed read URLs for private files (seconds). */
export const DOWNLOAD_URL_TTL = 5 * 60;
/** Signed read URLs embedded in list responses, such as video players (seconds). */
export const EMBED_URL_TTL = 60 * 60;
/** Unfinished uploads one account may start per 24 hours. */
export const MAX_PENDING_UPLOADS = 10;
export const MAX_TUTOR_VIDEOS = 3;
export const MAX_TUTOR_CREDENTIALS = 20;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType] ?? "bin";
}

/** Bytes to read from the start of an object before calling sniffMatches. */
export const SNIFF_BYTES = 16;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** True when the file's first bytes are what its declared content type says. */
export function sniffMatches(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
    case "video/mp4":
    case "video/quicktime":
      // ISO base media: a size, then "ftyp". Older QuickTime files start with other atoms.
      return (
        startsWith(bytes, ascii("ftyp"), 4) ||
        (contentType === "video/quicktime" &&
          ["moov", "mdat", "wide", "free", "skip"].some((atom) =>
            startsWith(bytes, ascii(atom), 4),
          ))
      );
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}
