import { describe, expect, it } from "vitest";
import { createTestApp } from "../tests/helpers.js";

type Operation = {
  tags?: string[];
  summary?: string;
  security?: unknown[];
  "x-roles"?: string;
  responses: Record<string, { description: string; content?: unknown }>;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

async function loadSpec() {
  const app = await createTestApp();
  await app.ready();
  const spec = app.swagger() as {
    openapi: string;
    paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
    components: { schemas: Record<string, unknown> };
  };
  return { app, spec };
}

describe("OpenAPI document", () => {
  it("documents every route with a tag, summary, auth and a typed success response", async () => {
    const { spec } = await loadSpec();
    const problems: string[] = [];

    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const name = `${method.toUpperCase()} ${path}`;
        if (!op.tags?.length) problems.push(`${name}: no tag`);
        if (!op.summary) problems.push(`${name}: no summary`);
        if (!op.security || !op["x-roles"]) problems.push(`${name}: no auth (use routeDocs)`);
        const success = Object.entries(op.responses).filter(([status]) => status.startsWith("2"));
        if (success.length === 0) problems.push(`${name}: no 2xx response`);
        for (const [status, response] of success) {
          if (response.description === "Default Response") {
            problems.push(`${name}: ${status} has no response schema`);
          }
          if (status !== "204" && !response.content) {
            problems.push(`${name}: ${status} has no body schema`);
          }
        }
        if (!op.responses["500"]) problems.push(`${name}: error responses missing`);
      }
    }

    expect(problems).toEqual([]);
  });

  it("only keeps components the paths reference", async () => {
    const { spec } = await loadSpec();
    const used = JSON.stringify(spec.paths);
    const schemas = JSON.stringify(spec.components.schemas);
    for (const name of Object.keys(spec.components.schemas)) {
      const ref = `"#/components/schemas/${name}"`;
      expect(used.includes(ref) || schemas.includes(ref), name).toBe(true);
    }
  });

  it("serves the document and the UI outside production", async () => {
    const { app } = await loadSpec();
    const json = await app.inject({ method: "GET", url: "/docs/json" });
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body).openapi).toBe("3.1.0");
    const ui = await app.inject({ method: "GET", url: "/docs/" });
    expect(ui.statusCode).toBe(200);
  });
});
