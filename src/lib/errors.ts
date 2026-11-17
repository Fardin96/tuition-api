// Single source of truth for API error codes. The frontend keeps a copy of ERROR_CODES.
export const ERROR_CODES = {
  ValidationError: "VALIDATION_ERROR",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  NotImplemented: "NOT_IMPLEMENTED",
  RateLimited: "RATE_LIMITED",
  InternalError: "INTERNAL_ERROR",
  ProfileExists: "PROFILE_EXISTS",
  PhoneInUse: "PHONE_IN_USE",
  WhatsappInUse: "WHATSAPP_IN_USE",
  RequirementLimitReached: "REQUIREMENT_LIMIT_REACHED",
  RequirementIsDefault: "REQUIREMENT_IS_DEFAULT",
  RequirementArchived: "REQUIREMENT_ARCHIVED",
  RequirementHasNoSubjects: "REQUIREMENT_NO_SUBJECTS",
  RequirementLosesLastSubject: "REQUIREMENT_LOSES_LAST_SUBJECT",
  InvalidRequirement: "INVALID_REQUIREMENT",
  InvalidSubjectOrZone: "INVALID_SUBJECT_OR_ZONE",
  AreaOutsideCity: "AREA_OUTSIDE_CITY",
  ZoneLimitReached: "ZONE_LIMIT_REACHED",
  ZoneRequestPending: "ZONE_REQUEST_PENDING",
  ZoneRequestDecided: "ZONE_REQUEST_DECIDED",
  ProfileIncomplete: "PROFILE_INCOMPLETE",
  AlreadyApplied: "ALREADY_APPLIED",
  ApplicationClosed: "APPLICATION_CLOSED",
  ListingNotOpen: "LISTING_NOT_OPEN",
  InvalidApplicationState: "INVALID_APPLICATION_STATE",
  InvalidAdminState: "INVALID_ADMIN_STATE",
  InvalidAccountState: "INVALID_ACCOUNT_STATE",
  InvalidFeeState: "INVALID_FEE_STATE",
  PackageAlreadyModerated: "PACKAGE_ALREADY_MODERATED",
  SubjectExists: "SUBJECT_EXISTS",
  AreaExists: "AREA_EXISTS",
} as const;

export type ErrorName = keyof typeof ERROR_CODES;
export type ErrorCode = (typeof ERROR_CODES)[ErrorName];

const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODES));

const STATUS_FALLBACK: Record<number, ErrorName> = {
  400: "ValidationError",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  429: "RateLimited",
  501: "NotImplemented",
};

export type ErrorIssue = { path: (string | number)[]; message: string };

export type AppError = Error & {
  name: ErrorName;
  statusCode: number;
  code: ErrorCode;
  details?: Record<string, unknown>;
  /** Sent top-level, like the issues of a body validation error, so the frontend maps them to fields. */
  issues?: ErrorIssue[];
};

export function appError(
  name: ErrorName,
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return Object.assign(new Error(message), {
    name,
    statusCode,
    code: ERROR_CODES[name],
    ...(details ? { details } : {}),
  });
}

export function notFound(message: string) {
  return appError("NotFound", 404, message);
}

// A 400 VALIDATION_ERROR shaped like a body validation error, for rules checked on merged values.
export function validationIssuesError(
  message: string,
  issues: { path: string; message: string }[],
): AppError {
  return Object.assign(appError("ValidationError", 400, message), {
    issues: issues.map((issue) => ({ path: [issue.path], message: issue.message })),
  });
}

// Fastify and Prisma errors carry their own `code` (FST_ERR_*, P2002); only our catalogue codes pass through.
export function errorCodeOf(err: {
  name?: string;
  code?: unknown;
  statusCode?: number;
}): ErrorCode {
  if (typeof err.code === "string" && KNOWN_CODES.has(err.code)) return err.code as ErrorCode;
  if (err.name && err.name in ERROR_CODES) return ERROR_CODES[err.name as ErrorName];
  const status = err.statusCode ?? 500;
  return ERROR_CODES[STATUS_FALLBACK[status] ?? "InternalError"];
}
