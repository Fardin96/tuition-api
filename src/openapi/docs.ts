import type { AuthContext } from "../modules/auth/auth.schema.js";

export const TAGS = [
  { name: "Health", description: "Liveness and database check." },
  { name: "Auth", description: "Google sign-in, token refresh, sessions and consent." },
  { name: "Account", description: "The signed-in account (/me)." },
  { name: "Students", description: "Student profiles." },
  { name: "Tutors", description: "Tutor profiles, search, credentials and videos." },
  { name: "Tutor requirements", description: "A tutor's requirement sets." },
  { name: "Tutor zones", description: "A tutor's teaching zones and zone-limit requests." },
  { name: "Requirements", description: "Student tuition requirements." },
  { name: "Packages", description: "Tutor tuition packages." },
  {
    name: "Applications",
    description: "Tutor applications to requirements and student requests for packages.",
  },
  { name: "Notifications", description: "In-app alerts for the dashboard bell." },
  { name: "Videos", description: "Public tutor videos." },
  { name: "Lookups", description: "Seeded reference data." },
  { name: "Admin", description: "Admin queues. Needs an ACTIVE admin_user row." },
] as const;

export type Tag = (typeof TAGS)[number]["name"];

/**
 * Who may call a route:
 * - "public": no token needed, the response is the same for everyone.
 * - "optional": no token needed; a token only changes caching (private, no-store).
 * - "any": any signed-in account.
 * - a role list: one of these roles (checked by requireRole).
 * - "admin": role ADMIN with an ACTIVE admin_user row (checked by requireAdmin).
 */
export type RouteAuth = "public" | "optional" | "any" | "admin" | readonly AuthContext["role"][];

/** Error statuses a route can return beyond the ones derived from `auth` and its schema. */
export type DocErrorStatus = 400 | 401 | 403 | 404 | 409 | 501 | 503;

export type RouteDocsOptions = {
  tag: Tag;
  summary: string;
  description?: string;
  auth: RouteAuth;
  /**
   * Extra error statuses. Added for you: 400 when the route validates input, 401 for signed-in
   * routes, 403 for role and admin routes, 501 for deferred routes, and 429 and 500 everywhere.
   */
  errors?: readonly DocErrorStatus[];
  /** Per-route limit, for example "20/min per account". Routes without one share the global 100/min. */
  rateLimit?: string;
  /** The route replies 204 with no body. */
  noContent?: boolean;
  /** The route is a stub that answers 501 until its feature lands. */
  deferred?: boolean;
};

const BEARER = [{ bearerAuth: [] }] as const;

function roleText(auth: RouteAuth): string {
  if (auth === "public") return "Public";
  if (auth === "optional") return "Public; signed-in callers get Cache-Control: private, no-store";
  if (auth === "any") return "Any signed-in account";
  if (auth === "admin") return "ADMIN with an ACTIVE admin_user row";
  return auth.join(", ");
}

/**
 * OpenAPI metadata for a route. Spread it into the route's `schema`:
 * `schema: { ...routeDocs({ tag: "Tutor zones", summary: "List my zones", auth: ["TUTOR"] }), response }`.
 * The `x-errors` and `x-no-content` keys are read by the swagger transform and never reach Fastify's
 * serializer, so documenting an error status does not change what the route sends.
 */
export function routeDocs(opts: RouteDocsOptions) {
  const signedIn = opts.auth !== "public" && opts.auth !== "optional";
  const errors = new Set<number>(opts.errors ?? []);
  if (signedIn) errors.add(401);
  if (opts.auth !== "public" && opts.auth !== "optional" && opts.auth !== "any") errors.add(403);
  if (opts.deferred) errors.add(501);
  errors.add(429);
  errors.add(500);

  const lines = [opts.description, `**Who:** ${roleText(opts.auth)}.`];
  lines.push(`**Rate limit:** ${opts.rateLimit ?? "global 100/min"}.`);

  return {
    tags: [opts.tag],
    summary: opts.summary,
    description: lines.filter(Boolean).join("\n\n"),
    security:
      opts.auth === "public" ? [] : opts.auth === "optional" ? [{}, ...BEARER] : [...BEARER],
    ...(opts.deferred ? { "x-deferred": true } : {}),
    "x-roles": roleText(opts.auth),
    ...(opts.rateLimit ? { "x-rate-limit": opts.rateLimit } : {}),
    "x-errors": [...errors].sort((a, b) => a - b),
    ...(opts.noContent ? { "x-no-content": true } : {}),
  };
}
