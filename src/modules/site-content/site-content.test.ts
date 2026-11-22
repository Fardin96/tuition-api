import { describe, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createFakeStorage,
  createFileAsset,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";
import defaults from "./defaults.json" with { type: "json" };
import {
  BLOCK_SCHEMAS,
  LANDING_KEYS,
  PAGE_KEYS,
  SITE_CONTENT_KEYS,
} from "./site-content.schema.js";

const URL = "/api/v1/site-content";
const CACHE = "public, max-age=300, stale-while-revalidate=600";
const PAGE_SLUG_KEYS = {
  "about-us": "about_page",
  terms: "terms_page",
  privacy: "privacy_page",
  contact: "contact_page",
} as const;

type Json = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: test fixtures
type Loose = Record<string, any>;

describe("site content defaults", () => {
  it("has exactly the fourteen keys", () => {
    expect(Object.keys(defaults).sort()).toEqual([...SITE_CONTENT_KEYS].sort());
    expect(SITE_CONTENT_KEYS).toHaveLength(14);
  });

  it.each(SITE_CONTENT_KEYS.map((key) => [key]))("%s default passes its schema", (key) => {
    const result = BLOCK_SCHEMAS[key].safeParse((defaults as Json)[key]);
    expect(result.success).toBe(true);
  });
});

describe("public site content", () => {
  describe("GET /api/v1/site-content", () => {
    it("returns the ten landing keys, all defaults when no rows exist", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Json;
      expect(Object.keys(body).sort()).toEqual([...LANDING_KEYS].sort());
      for (const key of LANDING_KEYS) {
        expect(body[key]).toEqual((defaults as Json)[key]);
      }
    });

    it("never includes updatedBy", async () => {
      const app = await createTestApp();
      await prisma.siteContent.create({
        data: { key: "seo", value: (defaults as Json).seo as never },
      });

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.body).not.toContain("updatedBy");
    });

    it("lets a stored override win while the other blocks stay default", async () => {
      const app = await createTestApp();
      const seo = { title: "Masters Hub: find a tutor", description: "Tutors across Dhaka." };
      await prisma.siteContent.create({ data: { key: "seo", value: seo } });

      const res = await app.inject({ method: "GET", url: URL });

      const body = JSON.parse(res.body) as Json;
      expect(body.seo).toEqual(seo);
      for (const key of LANDING_KEYS.filter((k) => k !== "seo")) {
        expect(body[key]).toEqual((defaults as Json)[key]);
      }
    });

    it("falls back to the default for a row with a wrong shape", async () => {
      const app = await createTestApp();
      await prisma.siteContent.create({ data: { key: "seo", value: { title: 5 } } });
      await prisma.siteContent.create({ data: { key: "hero", value: "not an object" } });

      const res = await app.inject({ method: "GET", url: URL });

      const body = JSON.parse(res.body) as Json;
      expect(body.seo).toEqual((defaults as Json).seo);
      expect(body.hero).toEqual((defaults as Json).hero);
    });

    it("drops unknown fields from a stored row", async () => {
      const app = await createTestApp();
      const seo = { ...((defaults as Json).seo as Json), legacyFlag: true };
      await prisma.siteContent.create({ data: { key: "seo", value: seo } });

      const res = await app.inject({ method: "GET", url: URL });

      const body = JSON.parse(res.body) as { seo: Json };
      expect(body.seo).not.toHaveProperty("legacyFlag");
      expect(body.seo).toEqual((defaults as Json).seo);
    });

    it("ignores rows whose key is not a landing block", async () => {
      const app = await createTestApp();
      await prisma.siteContent.create({ data: { key: "old_block", value: { anything: true } } });

      const res = await app.inject({ method: "GET", url: URL });

      const body = JSON.parse(res.body) as Json;
      expect(Object.keys(body)).not.toContain("old_block");
      expect(Object.keys(body)).toHaveLength(10);
    });

    it("sends a public cache header to anonymous callers", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.headers["cache-control"]).toBe(CACHE);
      expect(res.headers.vary).toContain("Authorization");
    });

    it("sends a browser-only cache header to signed-in callers", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
      expect(res.headers.vary).toContain("Authorization");
    });
  });

  describe("GET /api/v1/site-content/pages/:slug", () => {
    it.each(Object.entries(PAGE_SLUG_KEYS))(
      "returns the default for %s with updatedAt null",
      async (slug, key) => {
        const app = await createTestApp();

        const res = await app.inject({ method: "GET", url: `${URL}/pages/${slug}` });

        expect(res.statusCode).toBe(200);
        const page = (defaults as Json)[key] as {
          title: string;
          description: string;
          body: string;
        };
        expect(JSON.parse(res.body)).toEqual({
          slug,
          title: page.title,
          description: page.description,
          body: page.body,
          updatedAt: null,
        });
      },
    );

    it("sends the shared cache header to anonymous callers and a browser-only one to signed-in callers", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const anonymous = await app.inject({ method: "GET", url: `${URL}/pages/terms` });
      const signedIn = await app.inject({
        method: "GET",
        url: `${URL}/pages/terms`,
        headers: await getAuthHeaders(student),
      });

      expect(anonymous.headers["cache-control"]).toBe(
        "public, max-age=300, stale-while-revalidate=600",
      );
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.headers["cache-control"]).toBe("private, max-age=300");
      expect(signedIn.headers.vary).toContain("Authorization");
      expect(signedIn.body).toBe(anonymous.body);
    });

    it("returns a stored page with its updatedAt", async () => {
      const app = await createTestApp();
      const row = await prisma.siteContent.create({
        data: {
          key: "terms_page",
          value: { title: "Terms", description: "Our terms.", body: "Be kind." },
        },
      });

      const res = await app.inject({ method: "GET", url: `${URL}/pages/terms` });

      const body = JSON.parse(res.body) as Json;
      expect(body).toEqual({
        slug: "terms",
        title: "Terms",
        description: "Our terms.",
        body: "Be kind.",
        updatedAt: row.updatedAt.toISOString(),
      });
    });

    it("answers 400 for an unknown slug", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: `${URL}/pages/careers` });

      expect(res.statusCode).toBe(400);
    });

    it("sends the public cache header to anonymous callers", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: `${URL}/pages/privacy` });

      expect(res.headers["cache-control"]).toBe(CACHE);
    });
  });

  it("lists every page key in the schema", () => {
    expect([...PAGE_KEYS].sort()).toEqual(Object.values(PAGE_SLUG_KEYS).sort());
  });
});

describe("uploaded media on the public site", () => {
  /** Stores the default testimonials block with its first photo replaced. */
  async function storePhoto(photo: string) {
    const testimonials = structuredClone((defaults as Json).testimonials) as Loose;
    testimonials.items[0].photo = photo;
    await prisma.siteContent.create({
      data: { key: "testimonials", value: testimonials as never },
    });
  }

  async function getContent() {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Loose;
  }

  it("answers an uploaded photo with its signed URL when the file is not published", async () => {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    await storePhoto(`file:${file.id}`);

    const body = await getContent();

    expect(body.testimonials.items[0].photo).toBe(
      `https://fake-r2.test/private/${file.storageKey}?get&expires=3600`,
    );
  });

  it("never serves a private upload, such as an ID, even if a stored row points at it", async () => {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const student = await createAccount({ role: "STUDENT" });
    const file = await createFileAsset(student.id, "STUDENT_ID", { contentType: "image/png" });
    await storePhoto(`file:${file.id}`);

    const body = await getContent();

    expect(body.testimonials).toEqual((defaults as Json).testimonials);
    expect(JSON.stringify(body)).not.toContain(file.storageKey);
  });

  it("answers a published photo with its public URL", async () => {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", {
      contentType: "image/png",
      publishedAt: new Date(),
    });
    await storePhoto(`file:${file.id}`);

    const body = await getContent();

    expect(body.testimonials.items[0].photo).toBe(`https://media.test/${file.storageKey}`);
  });

  it.each([
    [
      "the file is gone",
      (adminId: string) => createFileAsset(adminId, "SITE_IMAGE", { status: "DELETED" }),
    ],
    [
      "the upload never finished",
      (adminId: string) => createFileAsset(adminId, "SITE_IMAGE", { status: "PENDING_UPLOAD" }),
    ],
  ])("shows the whole default block, and warns with its key, when %s", async (_label, make) => {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await make(admin.id);
    await storePhoto(`file:${file.id}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const body = await getContent();

      expect(body.testimonials).toEqual((defaults as Json).testimonials);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"testimonials"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("shows the default when no record exists for the file id", async () => {
    setStorageForTests(createFakeStorage().storage);
    await storePhoto(`file:${crypto.randomUUID()}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const body = await getContent();

      expect(body.testimonials).toEqual((defaults as Json).testimonials);
    } finally {
      warn.mockRestore();
    }
  });

  it("shows the default when storage is not configured, and keeps the other blocks", async () => {
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    await storePhoto(`file:${file.id}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const body = await getContent();

      expect(body.testimonials).toEqual((defaults as Json).testimonials);
      expect(body.hero).toEqual((defaults as Json).hero);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"testimonials"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("answers an uploaded video in a how-it-works flow with its URL", async () => {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_VIDEO", {
      contentType: "video/mp4",
      publishedAt: new Date(),
    });
    const flow = structuredClone((defaults as Json).how_it_works) as Loose;
    flow.find.video.video = `file:${file.id}`;
    await prisma.siteContent.create({ data: { key: "how_it_works", value: flow as never } });

    const body = await getContent();

    expect(body.how_it_works.find.video.video).toBe(`https://media.test/${file.storageKey}`);
  });
});
