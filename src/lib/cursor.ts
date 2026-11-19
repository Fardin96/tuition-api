import { appError } from "./errors.js";

export type Cursor = { createdAt: Date; id: string };

// Opaque keyset cursor over (created_at, id). Clients pass it back unchanged.
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(raw: string): Cursor {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const date = new Date(createdAt);
    // Every paged model has a uuid id; a non-uuid one would reach a @db.Uuid filter and fail as a 500.
    if (typeof id !== "string" || !UUID.test(id) || Number.isNaN(date.getTime())) {
      throw new Error("bad cursor");
    }
    return { createdAt: date, id };
  } catch {
    throw appError("ValidationError", 400, "Invalid cursor");
  }
}
