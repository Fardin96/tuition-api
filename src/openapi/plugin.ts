import swagger, { type SwaggerTransform, type SwaggerTransformObject } from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform, jsonSchemaTransformObject } from "fastify-type-provider-zod";
import { env } from "../config/env.js";
import { TAGS } from "./docs.js";
import "./schemas.js";

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Validation failed (VALIDATION_ERROR with `issues`) or the request breaks a business rule",
  401: "Missing, invalid or expired access token",
  403: "The account's role cannot call this route",
  404: "Not found",
  409: "Conflict with the current state",
  429: "Rate limit hit",
  500: "Unexpected error. In production the message is masked",
  501: "Not implemented yet",
  503: "Temporarily unavailable",
};

const SUCCESS_DESCRIPTIONS: Record<string, string> = { "200": "OK", "201": "Created" };

const ERROR_REF ={ $ref: "#/components/schemas/ErrorResponse" };

type DocSchema = Record<string, unknown> & { response?: Record<string, unknown> };

// Adds the documented error and 204 responses on top of the zod transform. They exist only in the
// document: the route's runtime `response` (and so the serializer) is never touched.
const transform: SwaggerTransform = (input) => {
  const result = jsonSchemaTransform(input as Parameters<typeof jsonSchemaTransform>[0]);
  const schema = result.schema as DocSchema | undefined;
  if (!schema || schema.hide) return result;

  const { "x-errors": errors, "x-no-content": noContent, ...rest } = schema;
  const response: Record<string, unknown> = {};
  for (const [status, body] of Object.entries(rest.response ?? {})) {
    const description = SUCCESS_DESCRIPTIONS[status];
    response[status] =
      description && body && typeof body === "object" && !("description" in body)
        ? { ...body, description }
        : body;
  }
  if (noContent && !response["204"]) {
    response["204"] = { type: "null", description: "No content" };
  }
  const statuses = new Set((errors as number[] | undefined) ?? []);
  const source = input.schema as DocSchema | undefined;
  if (source?.body || source?.querystring || source?.params) statuses.add(400);
  for (const status of [...statuses].sort((a, b) => a - b)) {
    response[String(status)] ??= { ...ERROR_REF, description: ERROR_DESCRIPTIONS[status] };
  }
  return { ...result, schema: { ...rest, response } };
};

function collectRefs(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") into.add(child.split("/").pop() ?? "");
      else collectRefs(child, into);
    }
  }
}

// The zod transform emits every registered schema twice (`X` and `XInput`). Keep only the ones the
// paths reach, so the frontend's generated types stay small.
const transformObject: SwaggerTransformObject = (input) => {
  const doc = jsonSchemaTransformObject(input) as {
    paths?: unknown;
    components?: { schemas?: Record<string, unknown> };
  };
  const all = doc.components?.schemas ?? {};
  const keep = new Set<string>();
  collectRefs(doc.paths, keep);
  const queue = [...keep];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    const found = new Set<string>();
    collectRefs(all[name], found);
    for (const ref of found) {
      if (!keep.has(ref)) {
        keep.add(ref);
        queue.push(ref);
      }
    }
  }
  const schemas = Object.fromEntries(
    Object.keys(all)
      .filter((name) => keep.has(name))
      .sort()
      .map((name) => [name, all[name]]),
  );
  return {
    ...doc,
    components: { ...doc.components, schemas },
  } as ReturnType<SwaggerTransformObject>;
};

export function docsEnabled() {
  return env.API_DOCS ? env.API_DOCS === "true" : env.NODE_ENV !== "production";
}

/** Register before any route: @fastify/swagger collects routes through an onRoute hook. */
export async function registerOpenApi(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Tuition Media API",
        version: "1.0.0",
        description:
          "Backend for Tuition Media. Every path is under `/api/v1`. Send the access token from " +
          "`POST /api/v1/auth/google` as `Authorization: Bearer <token>`.\n\n" +
          "Errors share one body (`ErrorResponse`); match on `code`.",
      },
      tags: TAGS.map((tag) => ({ ...tag })),
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform,
    transformObject,
  });

  if (docsEnabled()) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true, persistAuthorization: true },
      staticCSP: true,
    });
  }
}
