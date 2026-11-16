import { appError } from "./errors.js";

export type Cursor = { createdAt: Date; id: string };

// Opaque keyset cursor over (created_at, id). Clients pass it back unchanged.
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): Cursor {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const date = new Date(createdAt);
    if (typeof id !== "string" || Number.isNaN(date.getTime())) throw new Error("bad cursor");
    return { createdAt: date, id };
  } catch {
    throw appError("ValidationError", 400, "Invalid cursor");
  }
}
