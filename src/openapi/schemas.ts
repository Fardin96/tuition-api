import { z } from "zod";
import { ERROR_CODES } from "../lib/errors.js";

// Docs-only: these describe the global error handler's body in the OpenAPI document.
// They are never put in a route's `response`, so the serializer does not run them.

export const errorCodeSchema = z
  .enum(Object.values(ERROR_CODES) as [string, ...string[]])
  .meta({ id: "ErrorCode", description: "Machine-readable error code. Match on this." });

export const errorIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .meta({ id: "ErrorIssue" });

export const errorResponseSchema = z
  .object({
    error: z.string().meta({ description: "Error name, for example RequirementInUse." }),
    code: errorCodeSchema,
    message: z.string().meta({ description: "Human-readable message." }),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: "Ids related to the error. Omitted on masked 5xx responses." }),
    issues: z
      .array(errorIssueSchema)
      .optional()
      .meta({ description: "One entry per zod issue. Sent only with VALIDATION_ERROR." }),
  })
  .meta({ id: "ErrorResponse" });
