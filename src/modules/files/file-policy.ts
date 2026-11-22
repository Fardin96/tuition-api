import type { FilePurpose, Role } from "../../generated/prisma/enums.js";

// What each purpose accepts and who may upload it. The single source for upload limits.

const MB = 1024 * 1024;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const DOCUMENT_TYPES = [...IMAGE_TYPES, "application/pdf"] as const;
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"] as const;
// Site and story videos play on the landing page in any browser, so no QuickTime.
const WEB_VIDEO_TYPES = ["video/mp4", "video/webm"] as const;

export type FilePolicy = {
  /** Who may start an upload of this purpose. ADMIN means an ACTIVE admin. */
  roles: readonly Role[];
  contentTypes: readonly string[];
  maxBytes: number;
};

export const FILE_POLICY: Record<FilePurpose, FilePolicy> = {
  STUDENT_ID: { roles: ["STUDENT"], contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  TUTOR_ID: { roles: ["TUTOR"], contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  CREDENTIAL: { roles: ["TUTOR"], contentTypes: DOCUMENT_TYPES, maxBytes: 2 * MB },
  TUTOR_VIDEO: { roles: ["TUTOR"], contentTypes: VIDEO_TYPES, maxBytes: 2 * MB },
  BLOG_COVER: { roles: ["ADMIN"], contentTypes: IMAGE_TYPES, maxBytes: 2 * MB },
  SITE_IMAGE: { roles: ["ADMIN"], contentTypes: IMAGE_TYPES, maxBytes: 5 * MB },
  SITE_VIDEO: { roles: ["ADMIN"], contentTypes: WEB_VIDEO_TYPES, maxBytes: 25 * MB },
  STORY_IMAGE: { roles: ["STUDENT", "TUTOR"], contentTypes: IMAGE_TYPES, maxBytes: 5 * MB },
  STORY_VIDEO: { roles: ["STUDENT"], contentTypes: WEB_VIDEO_TYPES, maxBytes: 25 * MB },
};

/** Signed upload URLs live this long (seconds). */
export const UPLOAD_URL_TTL = 10 * 60;
/** Signed read URLs for private files (seconds). */
export const DOWNLOAD_URL_TTL = 5 * 60;
/** Signed read URLs embedded in list responses, such as video players (seconds). */
export const EMBED_URL_TTL = 60 * 60;
/**
 * Embed links are signed at the start of a window this long (seconds), so every response inside
 * one window carries the same URL and browsers and CDNs can reuse it. A link expires at the start
 * of its window plus this window plus EMBED_URL_TTL: it is valid for at least EMBED_URL_TTL after
 * it is issued, and at most EMBED_URL_TTL + this window (90 minutes) after.
 */
export const EMBED_URL_WINDOW = 30 * 60;
/**
 * Uploads one account may have started in the last 24 hours that nothing uses yet: unfinished,
 * or finished but not attached. Attached files do not count, so a tutor can still upload every
 * credential; this only stops storage being filled with files that are never used.
 */
export const MAX_UNUSED_UPLOADS = 10;
/** Longest stored file name, in characters. Longer names are shortened, keeping the extension. */
export const MAX_FILE_NAME = 200;
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

// Control characters (Cc) and invisible format characters (Cf), which include the direction
// overrides that can make "fdp.exe" read as "exe.pdf".
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}]/gu;

/**
 * The name to store for an uploaded file, or null when nothing usable is left. Drops any path
 * (some browsers send "C:\\fakepath\\..."), removes control and direction characters, folds
 * whitespace and shortens it to MAX_FILE_NAME characters, keeping the extension.
 */
export function cleanFileName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const name = base.normalize("NFC").replace(UNSAFE_NAME_CHARS, "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  const chars = [...name];
  if (chars.length <= MAX_FILE_NAME) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? [...name.slice(dot)] : [];
  if (ext.length === 0 || ext.length > 16) return chars.slice(0, MAX_FILE_NAME).join("").trim();
  return (
    chars
      .slice(0, MAX_FILE_NAME - ext.length)
      .join("")
      .trimEnd() + ext.join("")
  );
}

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
