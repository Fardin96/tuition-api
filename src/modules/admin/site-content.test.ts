import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createFakeStorage,
  createFileAsset,
  createStoryRow,
  createStudentProfile,
  createSuperAdmin,
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { runFileCleanup } from "../files/file-cleanup.service.js";
import { fileInUse } from "../files/files.service.js";
import defaults from "../site-content/defaults.json" with { type: "json" };
import { SITE_CONTENT_KEYS } from "../site-content/site-content.schema.js";

const URL = "/api/v1/admin/site-content";

// Block fixtures are loosely typed on purpose: each test edits one nested field.
// biome-ignore lint/suspicious/noExplicitAny: test fixtures
type Json = Record<string, any>;
type Item = {
  key: string;
  value: Json;
  defaultValue: Json;
  media: Record<
    string,
    { url: string | null; contentType: string; originalName: string | null; purpose: string }
  >;
  isDefault: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

const base = (key: string): Json => structuredClone((defaults as Record<string, Json>)[key]);

function adminHeaders(account: Parameters<typeof getAuthHeaders>[0]) {
  return getAuthHeaders(account);
}

async function put(
  app: Awaited<ReturnType<typeof createTestApp>>,
  account: Parameters<typeof getAuthHeaders>[0],
  key: string,
  payload: Json,
) {
  return app.inject({
    method: "PUT",
    url: `${URL}/${key}`,
    headers: await adminHeaders(account),
    payload,
  });
}

async function saveHero(
  app: Awaited<ReturnType<typeof createTestApp>>,
  account: Parameters<typeof getAuthHeaders>[0],
  value: Json,
  expectedUpdatedAt: string | null = null,
) {
  return put(app, account, "hero", { value, expectedUpdatedAt });
}

async function adminNameOf(accountId: string) {
  return (await prisma.adminUser.findUniqueOrThrow({ where: { accountId } })).name;
}

describe("admin site content", () => {
  describe("GET /api/v1/admin/site-content", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(401);
    });

    it.each(["STUDENT", "TUTOR"] as const)("rejects a %s token with 403", async (role) => {
      const app = await createTestApp();
      const account = await createAccount({ role });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lets a plain ACTIVE admin and a super admin read the list", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE", adminRole: "ADMIN" });
      const superAdmin = await createSuperAdmin();

      const plain = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });
      const sup = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(superAdmin),
      });

      expect(plain.statusCode).toBe(200);
      expect(sup.statusCode).toBe(200);
    });

    it("lists the fourteen keys in order, with defaults and no rows", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const { items } = JSON.parse(res.body) as { items: Item[] };
      expect(items.map((item) => item.key)).toEqual([...SITE_CONTENT_KEYS]);
      for (const item of items) {
        expect(item.isDefault).toBe(true);
        expect(item.value).toEqual(item.defaultValue);
        expect(item.defaultValue).toEqual((defaults as Record<string, Json>)[item.key]);
        expect(item.updatedAt).toBeNull();
        expect(item.updatedByName).toBeNull();
      }
    });

    it("reports the saved value, the editor name and isDefault false for a saved block", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const hero = { ...base("hero"), headline: "Find a tutor today." };
      await saveHero(app, admin, hero);

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      const { items } = JSON.parse(res.body) as { items: Item[] };
      const item = items.find((i) => i.key === "hero");
      expect(item?.isDefault).toBe(false);
      expect(item?.value.headline).toBe("Find a tutor today.");
      expect(item?.defaultValue).toEqual(base("hero"));
      expect(item?.updatedByName).toBe(await adminNameOf(admin.id));
      expect(item?.updatedAt).not.toBeNull();
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("PUT /api/v1/admin/site-content/:key", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "PUT",
        url: `${URL}/hero`,
        payload: { value: base("hero"), expectedUpdatedAt: null },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a student token with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await saveHero(app, student, base("hero"));

      expect(res.statusCode).toBe(403);
    });

    it("rejects an unknown key with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await put(app, admin, "sidebar", { value: {}, expectedUpdatedAt: null });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("rejects a missing value with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await put(app, admin, "hero", { expectedUpdatedAt: null });

      expect(res.statusCode).toBe(400);
    });

    it("round-trips a simple block and trims its text", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const hero = { ...base("hero"), tagline: "  New tagline  ", headline: "Fresh headline" };

      const res = await saveHero(app, admin, hero);

      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body) as Item;
      expect(item.key).toBe("hero");
      expect(item.isDefault).toBe(false);
      expect(item.value.tagline).toBe("New tagline");
      expect(item.value.headline).toBe("Fresh headline");
    });

    it("round-trips a list block", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const faq = base("faq");
      faq.items = [
        { question: "  Is it free?  ", answer: "Browsing is free." },
        { question: "How do I pay?", answer: "Pay the placement fee online." },
      ];
      faq.openIndex = 1;

      const res = await put(app, admin, "faq", { value: faq, expectedUpdatedAt: null });

      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body) as Item;
      expect(item.value.items).toHaveLength(2);
      expect(item.value.items[0].question).toBe("Is it free?");
      expect(item.value.openIndex).toBe(1);
    });

    it.each([
      ["empty tagline", "hero", (v: Json) => ({ ...v, tagline: "" }), "value.tagline"],
      [
        "tagline too long",
        "hero",
        (v: Json) => ({ ...v, tagline: "x".repeat(61) }),
        "value.tagline",
      ],
      [
        "line break in headline",
        "hero",
        (v: Json) => ({ ...v, headline: "a\nb" }),
        "value.headline",
      ],
      [
        "testimonial comment over 90 words",
        "testimonials",
        (v: Json) => {
          v.items[0].comment = Array(91).fill("word").join(" ");
          return v;
        },
        "value.items.0.comment",
      ],
      ["no testimonials", "testimonials", (v: Json) => ({ ...v, items: [] }), "value.items"],
      [
        "too many testimonials",
        "testimonials",
        (v: Json) => ({ ...v, items: Array.from({ length: 13 }, () => v.items[0]) }),
        "value.items",
      ],
      [
        "faq openIndex past the list",
        "faq",
        (v: Json) => ({ ...v, openIndex: v.items.length }),
        "value.openIndex",
      ],
      ["bad email", "footer", (v: Json) => ({ ...v, email: "not-an-email" }), "value.email"],
      [
        "footer with two columns",
        "footer",
        (v: Json) => ({ ...v, columns: v.columns.slice(0, 2) }),
        "value.columns",
      ],
      [
        "duplicate social platform",
        "footer",
        (v: Json) => ({
          ...v,
          socials: [
            { platform: "instagram", href: "https://instagram.com/a" },
            { platform: "instagram", href: "https://instagram.com/b" },
          ],
        }),
        "value.socials",
      ],
      [
        "image outside /assets/",
        "testimonials",
        (v: Json) => {
          v.items[0].photo = "/etc/passwd.png";
          return v;
        },
        "value.items.0.photo",
      ],
      [
        "image with ..",
        "testimonials",
        (v: Json) => {
          v.items[0].photo = "/assets/../secret.png";
          return v;
        },
        "value.items.0.photo",
      ],
    ])("refuses %s with 400 and a value path", async (_label, key, change, path) => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const value = change(base(key));

      const res = await put(app, admin, key, { value, expectedUpdatedAt: null });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { code: string; issues: { path: string[] }[] };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues.some((issue) => issue.path[0] === path)).toBe(true);
      expect(body.issues.every((issue) => issue.path[0].startsWith("value."))).toBe(true);
    });

    it.each(["javascript:alert(1)", "//evil.com", "http://x.com", "blog"])(
      "refuses the link %s",
      async (href) => {
        const app = await createTestApp();
        const admin = await createAdmin({ status: "ACTIVE" });
        const nav = base("nav");
        nav.cta.href = href;

        const res = await put(app, admin, "nav", { value: nav, expectedUpdatedAt: null });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body) as { issues: { path: string[] }[] };
        expect(body.issues[0].path[0]).toMatch(/^value\./);
      },
    );

    it("drops an unknown field and stores the rest", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const hero = { ...base("hero"), headline: "Kept", secretNote: "internal" };

      const res = await saveHero(app, admin, hero);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).value).not.toHaveProperty("secretNote");
      const row = await prisma.siteContent.findUniqueOrThrow({ where: { key: "hero" } });
      expect(row.value).not.toHaveProperty("secretNote");
    });
  });

  describe("conflicts", () => {
    it("answers 409 SITE_CONTENT_CONFLICT for a stale expectedUpdatedAt", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const first = JSON.parse(
        (await saveHero(app, admin, { ...base("hero"), headline: "One" })).body,
      ) as Item;
      await saveHero(app, admin, { ...base("hero"), headline: "Two" }, first.updatedAt);

      const res = await saveHero(
        app,
        admin,
        { ...base("hero"), headline: "Three" },
        first.updatedAt,
      );

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SITE_CONTENT_CONFLICT");
    });

    it("answers 409 when null is sent but a row exists", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await saveHero(app, admin, { ...base("hero"), headline: "One" });

      const res = await saveHero(app, admin, { ...base("hero"), headline: "Two" }, null);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SITE_CONTENT_CONFLICT");
    });

    it("answers 409 when a timestamp is sent but no row exists", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await saveHero(app, admin, base("hero"), new Date().toISOString());

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SITE_CONTENT_CONFLICT");
    });

    it("saves when the timestamp matches", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const first = JSON.parse(
        (await saveHero(app, admin, { ...base("hero"), headline: "One" })).body,
      ) as Item;

      const res = await saveHero(app, admin, { ...base("hero"), headline: "Two" }, first.updatedAt);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).value.headline).toBe("Two");
    });
  });

  describe("audit", () => {
    it("writes one site_content.update row with the default as before, and no row for a repeat save", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const hero = { ...base("hero"), headline: "Audited headline" };
      const first = JSON.parse((await saveHero(app, admin, hero)).body) as Item;

      const audits = await prisma.auditLog.findMany({
        where: { action: "site_content.update", entityId: "hero" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entityType).toBe("site_content");
      expect(audits[0].actorAccountId).toBe(admin.id);
      expect(audits[0].before).toEqual({ value: base("hero") });

      const repeat = await saveHero(app, admin, hero, first.updatedAt);

      expect(repeat.statusCode).toBe(200);
      const after = await prisma.auditLog.count({
        where: { action: "site_content.update", entityId: "hero" },
      });
      expect(after).toBe(1);
    });

    it("reports updatedByName as the admin's name", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await saveHero(app, admin, { ...base("hero"), headline: "Named" });

      expect(JSON.parse(res.body).updatedByName).toBe(await adminNameOf(admin.id));
    });
  });

  describe("DELETE /api/v1/admin/site-content/:key", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "DELETE", url: `${URL}/hero` });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a student token with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "DELETE",
        url: `${URL}/hero`,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("removes the row, so the block shows its default again, and writes a reset audit", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const saved = { ...base("hero"), headline: "To be reset" };
      const row = JSON.parse((await saveHero(app, admin, saved)).body) as Item;

      const res = await app.inject({
        method: "DELETE",
        url: `${URL}/hero?expectedUpdatedAt=${encodeURIComponent(row.updatedAt ?? "")}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const item = JSON.parse(res.body) as Item;
      expect(item.isDefault).toBe(true);
      expect(item.value).toEqual(base("hero"));
      expect(item.updatedAt).toBeNull();
      expect(item.updatedByName).toBeNull();

      const stored = await prisma.siteContent.count({ where: { key: "hero" } });
      expect(stored).toBe(0);
      const audits = await prisma.auditLog.findMany({
        where: { action: "site_content.reset", entityId: "hero" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].before).toEqual({ value: saved });
      expect(audits[0].after).toEqual({ value: base("hero") });

      const publicRes = await app.inject({ method: "GET", url: "/api/v1/site-content" });
      expect(JSON.parse(publicRes.body).hero).toEqual(base("hero"));
    });

    it("answers 200 with the default and writes no audit when no row exists", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "DELETE",
        url: `${URL}/hero`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isDefault).toBe(true);
      const audits = await prisma.auditLog.count({ where: { action: "site_content.reset" } });
      expect(audits).toBe(0);
    });

    it("answers 409 SITE_CONTENT_CONFLICT for a stale expectedUpdatedAt", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const first = JSON.parse(
        (await saveHero(app, admin, { ...base("hero"), headline: "One" })).body,
      ) as Item;
      await saveHero(app, admin, { ...base("hero"), headline: "Two" }, first.updatedAt);

      const res = await app.inject({
        method: "DELETE",
        url: `${URL}/hero?expectedUpdatedAt=${encodeURIComponent(first.updatedAt ?? "")}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SITE_CONTENT_CONFLICT");
      expect(await prisma.siteContent.count({ where: { key: "hero" } })).toBe(1);
    });
  });
});

describe("admin site content: uploaded media", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function installStorage() {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    return fake;
  }

  /** The default testimonials block with its first photo replaced. */
  function testimonialsWithPhoto(photo: string): Json {
    const value = base("testimonials");
    value.items[0].photo = photo;
    return value;
  }

  /** The default how-it-works block with the "find" flow video replaced. */
  function howItWorksWithVideo(video: string): Json {
    const value = base("how_it_works");
    value.find.video.video = video;
    return value;
  }

  it("saves an uploaded photo, lists it under media, publishes it, and serves the public URL", async () => {
    const app = await createTestApp();
    const fake = installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    // Any admin may use an upload another admin made.
    const uploader = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(uploader.id, "SITE_IMAGE", { contentType: "image/png" });
    fake.put(file.storageKey, fakeFileBytes("image/png", 64), "image/png");

    const res = await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto(`file:${file.id}`),
      expectedUpdatedAt: null,
    });

    expect(res.statusCode).toBe(200);
    const item = JSON.parse(res.body) as Item;
    expect(item.value.items[0].photo).toBe(`file:${file.id}`);
    expect(item.media).toEqual({
      [file.id]: {
        url: `https://media.test/${file.storageKey}`,
        contentType: "image/png",
        originalName: null,
        purpose: "SITE_IMAGE",
      },
    });
    const joins = await prisma.siteContentFile.findMany({ where: { key: "testimonials" } });
    expect(joins.map((row) => row.fileId)).toEqual([file.id]);
    expect(fake.publicObjects.has(file.storageKey)).toBe(true);
    const stored = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
    expect(stored.publishedAt).not.toBeNull();

    const publicRes = await app.inject({ method: "GET", url: "/api/v1/site-content" });
    expect(JSON.parse(publicRes.body).testimonials.items[0].photo).toBe(
      `https://media.test/${file.storageKey}`,
    );
  });

  it("lists a file not yet published under a signed URL in the admin GET", async () => {
    const app = await createTestApp();
    installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_VIDEO", {
      contentType: "video/mp4",
      originalName: "Intro.mp4",
    });
    await prisma.siteContent.create({
      data: { key: "how_it_works", value: howItWorksWithVideo(`file:${file.id}`) as never },
    });

    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(admin),
    });

    const { items } = JSON.parse(res.body) as { items: Item[] };
    const flow = items.find((i) => i.key === "how_it_works");
    expect(flow?.media).toEqual({
      [file.id]: {
        url: `https://fake-r2.test/private/${file.storageKey}?get&expires=3600`,
        contentType: "video/mp4",
        originalName: "Intro.mp4",
        purpose: "SITE_VIDEO",
      },
    });
    expect(items.find((i) => i.key === "hero")?.media).toEqual({});
  });

  it("accepts an https photo and refuses a javascript: photo", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });

    const ok = await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto("https://cdn.example.com/client.png"),
      expectedUpdatedAt: null,
    });
    expect(ok.statusCode).toBe(200);

    const refused = await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto("javascript:alert(1)"),
      expectedUpdatedAt: null,
    });
    expect(refused.statusCode).toBe(400);
    const body = JSON.parse(refused.body) as { issues: { path: string[] }[] };
    expect(body.issues[0].path[0]).toBe("value.items.0.photo");
  });

  it("says what a video field accepts when the value is none of those", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });

    const res = await put(app, admin, "how_it_works", {
      value: howItWorksWithVideo("/etc/intro.mp4"),
      expectedUpdatedAt: null,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { issues: { path: string[]; message: string }[] };
    expect(body.issues).toContainEqual({
      path: ["value.find.video.video"],
      message: "Upload a video, pick one from the list, or use a link starting with https://",
    });
  });

  const GONE = "This file is gone or not finished uploading. Upload it again.";

  it.each([
    {
      label: "an unknown file id",
      make: async () => null,
      key: "testimonials" as const,
      path: "value.items.0.photo",
      message: GONE,
    },
    {
      label: "a file still uploading",
      make: (adminId: string) =>
        createFileAsset(adminId, "SITE_IMAGE", { status: "PENDING_UPLOAD" }),
      key: "testimonials" as const,
      path: "value.items.0.photo",
      message: GONE,
    },
    {
      label: "a deleted file",
      make: (adminId: string) => createFileAsset(adminId, "SITE_IMAGE", { status: "DELETED" }),
      key: "testimonials" as const,
      path: "value.items.0.photo",
      message: GONE,
    },
    {
      label: "a site video in a photo field",
      make: (adminId: string) =>
        createFileAsset(adminId, "SITE_VIDEO", { contentType: "video/mp4" }),
      key: "testimonials" as const,
      path: "value.items.0.photo",
      message: "Upload an image here.",
    },
    {
      label: "a blog cover in a photo field",
      make: (adminId: string) =>
        createFileAsset(adminId, "BLOG_COVER", { contentType: "image/png" }),
      key: "testimonials" as const,
      path: "value.items.0.photo",
      message: "Upload an image here.",
    },
    {
      label: "a site image in a video field",
      make: (adminId: string) =>
        createFileAsset(adminId, "SITE_IMAGE", { contentType: "image/png" }),
      key: "how_it_works" as const,
      path: "value.find.video.video",
      message: "Upload a video here.",
    },
  ])("refuses $label with 400 and a value path", async ({ make, key, path, message }) => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await make(admin.id);
    const ref = `file:${file?.id ?? crypto.randomUUID()}`;
    const value = key === "testimonials" ? testimonialsWithPhoto(ref) : howItWorksWithVideo(ref);

    const res = await put(app, admin, key, { value, expectedUpdatedAt: null });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as {
      code: string;
      issues: { path: string[]; message: string }[];
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.issues).toContainEqual({ path: [path], message });
    expect(await prisma.siteContentFile.count()).toBe(0);
  });

  it("refuses the whole block when one file is bad, and publishes nothing", async () => {
    const app = await createTestApp();
    const fake = installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const good = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    fake.put(good.storageKey, fakeFileBytes("image/png", 64), "image/png");
    const bad = await createFileAsset(admin.id, "SITE_VIDEO", { contentType: "video/mp4" });
    const value = base("testimonials");
    value.items[0].photo = `file:${good.id}`;
    value.items[1] = { ...structuredClone(value.items[0]), photo: `file:${bad.id}` };

    const res = await put(app, admin, "testimonials", { value, expectedUpdatedAt: null });

    expect(res.statusCode).toBe(400);
    expect(fake.publicObjects.has(good.storageKey)).toBe(false);
    expect(await prisma.siteContentFile.count()).toBe(0);
  });

  it("a shipped photo replaces an uploaded one and drops its join row", async () => {
    const app = await createTestApp();
    installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    const first = await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto(`file:${file.id}`),
      expectedUpdatedAt: null,
    });
    expect(first.statusCode).toBe(200);
    expect(await prisma.siteContentFile.count({ where: { key: "testimonials" } })).toBe(1);

    const res = await put(app, admin, "testimonials", {
      value: base("testimonials"),
      expectedUpdatedAt: (JSON.parse(first.body) as Item).updatedAt,
    });

    expect(res.statusCode).toBe(200);
    expect(await prisma.siteContentFile.count({ where: { key: "testimonials" } })).toBe(0);
    expect(await fileInUse(prisma, file.id)).toBe(false);
  });

  it("reset removes the join rows", async () => {
    const app = await createTestApp();
    installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    const saved = await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto(`file:${file.id}`),
      expectedUpdatedAt: null,
    });
    const { updatedAt } = JSON.parse(saved.body) as Item;

    const res = await app.inject({
      method: "DELETE",
      url: `${URL}/testimonials?expectedUpdatedAt=${encodeURIComponent(updatedAt ?? "")}`,
      headers: await getAuthHeaders(admin),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).media).toEqual({});
    expect(await prisma.siteContentFile.count()).toBe(0);
  });

  it("a file in use is kept by the cleanup sweep, an unused one is removed", async () => {
    const app = await createTestApp();
    const fake = installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const used = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    const unused = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    fake.put(used.storageKey, fakeFileBytes("image/png", 64), "image/png");
    fake.put(unused.storageKey, fakeFileBytes("image/png", 64), "image/png");
    await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto(`file:${used.id}`),
      expectedUpdatedAt: null,
    });
    expect(await fileInUse(prisma, used.id)).toBe(true);
    expect(await fileInUse(prisma, unused.id)).toBe(false);

    const result = await runFileCleanup(new Date(Date.now() + 8 * DAY));

    expect(result).toEqual({ expiredUploads: 0, orphansRemoved: 1, purged: 0 });
    const usedRow = await prisma.fileAsset.findUniqueOrThrow({ where: { id: used.id } });
    const unusedRow = await prisma.fileAsset.findUniqueOrThrow({ where: { id: unused.id } });
    expect(usedRow.status).toBe("UPLOADED");
    expect(unusedRow.status).toBe("DELETED");
    expect(fake.objects.has(used.storageKey)).toBe(true);
    expect(fake.objects.has(unused.storageKey)).toBe(false);
  });

  it("the sweep removes a file a block dropped, once the file is a week old", async () => {
    const app = await createTestApp();
    const fake = installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const file = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
    fake.put(file.storageKey, fakeFileBytes("image/png", 64), "image/png");
    await put(app, admin, "testimonials", {
      value: testimonialsWithPhoto(`file:${file.id}`),
      expectedUpdatedAt: null,
    });
    await put(app, admin, "testimonials", {
      value: base("testimonials"),
      expectedUpdatedAt: (
        await prisma.siteContent.findUniqueOrThrow({ where: { key: "testimonials" } })
      ).updatedAt.toISOString(),
    });

    const result = await runFileCleanup(new Date(Date.now() + 8 * DAY));

    expect(result.orphansRemoved).toBe(1);
    expect(fake.objects.has(file.storageKey)).toBe(false);
  });
});

describe("admin site content: cards from submissions", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function installStorage() {
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    return fake;
  }

  /** A testimonial card made from a story. */
  function storyCard(storyId: string, photo: string, extra: Json = {}): Json {
    return {
      name: "Ana",
      role: "Student",
      photo,
      quote: "Great help",
      comment: "Clear lessons every week",
      source: { kind: "story", id: storyId },
      ...extra,
    };
  }

  /** The default testimonials block with the given items. */
  function testimonials(items: Json[]): Json {
    const value = base("testimonials");
    value.items = items;
    return value;
  }

  async function studentStory(
    status: "APPROVED" | "PENDING" = "APPROVED",
    accountStatus: "ACTIVE" | "BLOCKED" = "ACTIVE",
  ) {
    const student = await createAccount({ role: "STUDENT", status: accountStatus });
    const area = await createArea();
    await createStudentProfile(student.id, area.id);
    const image = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    const story = await createStoryRow(student.id, { status, imageFileId: image.id });
    return { student, story, image };
  }

  /** A tutor video: approved, with the tutor's agreement to show it on the home page. */
  async function tutorVideo(options: { consent: boolean; status?: "APPROVED" | "PENDING" }) {
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "TUTOR_VIDEO", { contentType: "video/mp4" });
    const video = await prisma.tutorVideo.create({
      data: {
        tutorId: tutor.id,
        fileId: file.id,
        title: "Algebra in ten minutes",
        status: options.status ?? "APPROVED",
        landingConsentAt: options.consent ? new Date() : null,
      },
    });
    return { account, video, file };
  }

  it("keeps a student story's photo on the card, drops source from the public read, and keeps it for admins", async () => {
    const app = await createTestApp();
    const fake = installStorage();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { story, image } = await studentStory();
    fake.put(image.storageKey, fakeFileBytes("image/png", 64), "image/png");

    const res = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(story.id, `file:${image.id}`)]),
      expectedUpdatedAt: null,
    });

    expect(res.statusCode).toBe(200);
    const saved = JSON.parse(res.body) as Item;
    expect(saved.value.items[0].source).toEqual({ kind: "story", id: story.id });
    expect(saved.media[image.id]).toMatchObject({ purpose: "STORY_IMAGE" });

    const site = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/site-content" })).body,
    );
    expect(site.testimonials.items[0]).not.toHaveProperty("source");
    expect(site.testimonials.items[0].photo).toBe(`https://media.test/${image.storageKey}`);
    expect(await fileInUse(prisma, image.id)).toBe(true);
  });

  it("refuses a card whose story is still pending, with the issue on its source", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { story } = await studentStory("PENDING");

    const res = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(story.id, "/assets/testimonials/one.png")]),
      expectedUpdatedAt: null,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).issues).toEqual([
      {
        path: ["value.items.0.source"],
        message: "Only an approved submission can be shown on the landing page.",
      },
    ]);
  });

  it("refuses a story photo on a card that does not own it", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { image } = await studentStory();

    const res = await put(app, admin, "testimonials", {
      value: testimonials([
        {
          name: "Ana",
          role: "Student",
          photo: `file:${image.id}`,
          quote: "Great help",
          comment: "Clear lessons every week",
        },
      ]),
      expectedUpdatedAt: null,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).issues[0].message).toBe(
      "This file belongs to a user's submission. Add it with Add from submissions.",
    );
  });

  it("refuses a tutor's story on the testimonials list, and the same story twice", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const tutor = await createAccount({ role: "TUTOR" });
    await createTutorProfile(tutor.id);
    const tutorStory = await createStoryRow(tutor.id, { role: "TUTOR", status: "APPROVED" });
    const { story } = await studentStory();

    const asTestimonial = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(tutorStory.id, "/assets/testimonials/one.png")]),
      expectedUpdatedAt: null,
    });
    const twice = await put(app, admin, "testimonials", {
      value: testimonials([
        storyCard(story.id, "/assets/testimonials/one.png"),
        storyCard(story.id, "/assets/testimonials/two.png"),
      ]),
      expectedUpdatedAt: null,
    });

    expect(asTestimonial.statusCode).toBe(400);
    expect(JSON.parse(asTestimonial.body).issues[0].message).toBe(
      "Only a student's story can be a testimonial.",
    );
    expect(twice.statusCode).toBe(400);
  });

  it("a showcase video card needs the tutor's consent", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const withoutConsent = await tutorVideo({ consent: false });
    const withConsent = await tutorVideo({ consent: true });
    const card = (videoId: string, fileId: string) => ({
      kind: "video",
      name: "Rafi",
      subject: "Maths",
      thumbnail: "/assets/showcase/one.png",
      video: `file:${fileId}`,
      source: { kind: "tutor_video", id: videoId },
    });
    const showcase = (items: Json[]) => {
      const value = base("showcase");
      value.items = items;
      return value;
    };

    const refused = await put(app, admin, "showcase", {
      value: showcase([card(withoutConsent.video.id, withoutConsent.file.id)]),
      expectedUpdatedAt: null,
    });
    const allowed = await put(app, admin, "showcase", {
      value: showcase([card(withConsent.video.id, withConsent.file.id)]),
      expectedUpdatedAt: null,
    });

    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).issues[0].message).toBe(
      "The tutor has not agreed to show this video on the home page.",
    );
    expect(allowed.statusCode).toBe(200);
  });

  it("lists only eligible submissions in the picker, and marks the ones already on the landing page", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const used = await studentStory();
    await studentStory();
    await studentStory("PENDING");
    await studentStory("APPROVED", "BLOCKED");
    const put1 = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(used.story.id, "/assets/testimonials/one.png")]),
      expectedUpdatedAt: null,
    });
    expect(put1.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `${URL}/sources?for=testimonials`,
      headers: await adminHeaders(admin),
    });

    expect(res.statusCode).toBe(200);
    const { sources } = JSON.parse(res.body);
    const ids = sources.map((row: Json) => row.source.id);
    // Two active approved students are listed (the used one and the other); the pending and blocked ones are not.
    expect(ids).toHaveLength(2);
    expect(ids).toContain(used.story.id);
    expect(sources.find((row: Json) => row.source.id === used.story.id)).toMatchObject({
      onLanding: true,
      role: "STUDENT",
      headline: "A patient tutor",
      imageRef: `file:${used.image.id}`,
    });
  });

  it("lists approved tutor stories and consented tutor videos for the showcase, and nothing else", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const tutorAccount = await createAccount({ role: "TUTOR" });
    await createTutorProfile(tutorAccount.id);
    const comment = await createStoryRow(tutorAccount.id, { role: "TUTOR", status: "APPROVED" });
    await tutorVideo({ consent: true });
    await tutorVideo({ consent: false });
    await tutorVideo({ consent: true, status: "PENDING" });

    const res = await app.inject({
      method: "GET",
      url: `${URL}/sources?for=showcase`,
      headers: await adminHeaders(admin),
    });

    const { sources } = JSON.parse(res.body);
    expect(sources.map((row: Json) => row.source.kind).sort()).toEqual(["story", "tutor_video"]);
    const story = sources.find((row: Json) => row.source.kind === "story");
    expect(story).toMatchObject({ source: { id: comment.id }, role: "TUTOR", body: comment.body });
  });

  it("a save made from a stale editor answers 409 once a card's story was removed", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { student, story } = await studentStory();
    const first = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(story.id, "/assets/testimonials/one.png")]),
      expectedUpdatedAt: null,
    });
    const loadedAt = JSON.parse(first.body).updatedAt as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/me/stories/${story.id}`,
      headers: await getAuthHeaders(student),
    });
    expect(deleted.statusCode).toBe(204);

    // The row was deleted with its only card, so the editor's timestamp no longer matches.
    const stale = await put(app, admin, "testimonials", {
      value: testimonials([storyCard(story.id, "/assets/testimonials/one.png")]),
      expectedUpdatedAt: loadedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe("SITE_CONTENT_CONFLICT");
  });

  it("the cleanup sweep keeps a story's files and removes an unused one", async () => {
    const fake = installStorage();
    const { student, image } = await studentStory();
    const unused = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    fake.put(image.storageKey, fakeFileBytes("image/png", 64), "image/png");
    fake.put(unused.storageKey, fakeFileBytes("image/png", 64), "image/png");

    const result = await runFileCleanup(new Date(Date.now() + 8 * DAY));

    expect(result.orphansRemoved).toBe(1);
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: image.id } })).status).toBe(
      "UPLOADED",
    );
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: unused.id } })).status).toBe(
      "DELETED",
    );
  });
});
