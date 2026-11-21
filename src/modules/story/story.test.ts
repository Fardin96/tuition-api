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
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";
import defaults from "../site-content/defaults.json" with { type: "json" };

const URL = "/api/v1/me/stories";
const SITE_URL = "/api/v1/admin/site-content";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures
type Json = Record<string, any>;

async function studentWithProfile() {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  await createStudentProfile(account.id, area.id);
  return account;
}

async function tutorWithProfile() {
  const account = await createAccount({ role: "TUTOR" });
  await createTutorProfile(account.id);
  return account;
}

async function headers(account: Parameters<typeof getAuthHeaders>[0]) {
  return getAuthHeaders(account);
}

const studentStory = (overrides: Json = {}) => ({
  headline: "A patient tutor",
  body: "Lessons were clear and on time.",
  consent: true,
  ...overrides,
});

const tutorStory = (overrides: Json = {}) => ({
  body: "Clear explanations every week.",
  consent: true,
  ...overrides,
});

describe("GET /api/v1/me/stories", () => {
  it("rejects a request without a token with 401", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(401);
  });

  it("answers 403 to an admin and to a student or tutor without a profile", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const bareStudent = await createAccount({ role: "STUDENT" });
    const bareTutor = await createAccount({ role: "TUTOR" });

    const byAdmin = await app.inject({ method: "GET", url: URL, headers: await headers(admin) });
    const noStudent = await app.inject({
      method: "GET",
      url: URL,
      headers: await headers(bareStudent),
    });
    const noTutor = await app.inject({
      method: "GET",
      url: URL,
      headers: await headers(bareTutor),
    });

    expect(byAdmin.statusCode).toBe(403);
    expect(noStudent.statusCode).toBe(403);
    expect(JSON.parse(noStudent.body).code).toBe("PROFILE_INCOMPLETE");
    expect(noTutor.statusCode).toBe(403);
  });

  it("lists my stories with the limit state, and shows a hidden note to nobody", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    await createStoryRow(student.id, { status: "REJECTED", noteVisible: false });

    const res = await app.inject({ method: "GET", url: URL, headers: await headers(student) });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.max).toBe(3);
    expect(body.stories).toHaveLength(1);
    expect(body.stories[0].note).toBeNull();
    expect(body.stories[0].status).toBe("REJECTED");
    expect(body.canSubmit).toBe(true);
    expect(body.blockedReason).toBeNull();
  });

  it("shows the visible note of a rejected story", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    await createStoryRow(student.id, {
      status: "REJECTED",
      noteVisible: true,
      moderationNote: "Please keep it about the lessons.",
    });

    const res = await app.inject({ method: "GET", url: URL, headers: await headers(student) });

    expect(JSON.parse(res.body).stories[0].note).toBe("Please keep it about the lessons.");
  });

  it("says PENDING while a story waits, and LIMIT at three stories", async () => {
    const app = await createTestApp();
    const pending = await studentWithProfile();
    await createStoryRow(pending.id, { status: "PENDING" });
    const full = await studentWithProfile();
    await createStoryRow(full.id, { status: "APPROVED" });
    await createStoryRow(full.id, { status: "REJECTED" });
    await createStoryRow(full.id, { status: "REJECTED" });

    const waiting = JSON.parse(
      (await app.inject({ method: "GET", url: URL, headers: await headers(pending) })).body,
    );
    const limited = JSON.parse(
      (await app.inject({ method: "GET", url: URL, headers: await headers(full) })).body,
    );

    expect(waiting).toMatchObject({ canSubmit: false, blockedReason: "PENDING" });
    expect(limited).toMatchObject({ canSubmit: false, blockedReason: "LIMIT" });
  });
});

describe("POST /api/v1/me/stories", () => {
  it("rejects a request without a token with 401", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "POST", url: URL, payload: studentStory() });
    expect(res.statusCode).toBe(401);
  });

  it("sends a student's story with a photo and a clip, and it waits for review", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    const image = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    const video = await createFileAsset(student.id, "STORY_VIDEO", {
      contentType: "video/mp4",
      originalName: "class.mp4",
    });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory({ imageFileId: image.id, videoFileId: video.id }),
    });

    expect(res.statusCode).toBe(201);
    const story = JSON.parse(res.body);
    expect(story).toMatchObject({
      role: "STUDENT",
      headline: "A patient tutor",
      status: "PENDING",
      note: null,
      onLanding: false,
    });
    expect(story.image).toMatchObject({ contentType: "image/png" });
    expect(story.video).toMatchObject({ contentType: "video/mp4" });

    const row = await prisma.story.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.imageFileId).toBe(image.id);
    expect(row.videoFileId).toBe(video.id);
    expect(row.consentAt).toBeInstanceOf(Date);
  });

  it("sends a tutor's text-only story without a headline", async () => {
    const app = await createTestApp();
    const tutor = await tutorWithProfile();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(tutor),
      payload: tutorStory(),
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ role: "TUTOR", headline: null, video: null });
  });

  it.each([
    ["no consent", { consent: undefined }],
    ["consent false", { consent: false }],
  ])("refuses a student's story with %s (400)", async (_label, overrides) => {
    const app = await createTestApp();
    const student = await studentWithProfile();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory(overrides),
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.story.count({ where: { accountId: student.id } })).toBe(0);
  });

  it("refuses a tutor's story with no consent (400)", async () => {
    const app = await createTestApp();
    const tutor = await tutorWithProfile();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(tutor),
      payload: tutorStory({ consent: false }),
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses a tutor who sends a headline or a video (400)", async () => {
    const app = await createTestApp();
    const tutor = await tutorWithProfile();
    const video = await createFileAsset(tutor.id, "STORY_VIDEO", { contentType: "video/mp4" });

    const withHeadline = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(tutor),
      payload: tutorStory({ headline: "Not for tutors" }),
    });
    const withVideo = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(tutor),
      payload: tutorStory({ videoFileId: video.id }),
    });

    expect(withHeadline.statusCode).toBe(400);
    expect(withVideo.statusCode).toBe(400);
  });

  it("refuses a headline that spans two lines, and more than 90 words from a student", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();

    const twoLines = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory({ headline: "Great\ntutor" }),
    });
    const tooManyWords = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory({ body: Array.from({ length: 91 }, () => "word").join(" ") }),
    });

    expect(twoLines.statusCode).toBe(400);
    expect(tooManyWords.statusCode).toBe(400);
  });

  it("refuses a tutor's body over 300 characters (400)", async () => {
    const app = await createTestApp();
    const tutor = await tutorWithProfile();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(tutor),
      payload: tutorStory({ body: "x".repeat(301) }),
    });

    expect(res.statusCode).toBe(400);
  });

  it("refuses another account's file with 400 INVALID_FILE", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    const stranger = await createAccount({ role: "STUDENT" });
    const theirs = await createFileAsset(stranger.id, "STORY_IMAGE", { contentType: "image/png" });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory({ imageFileId: theirs.id }),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
  });

  it("refuses a clip while video uploads are paused (403 UPLOADS_BLOCKED)", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    const admin = await createAdmin({ status: "ACTIVE" });
    await prisma.uploadBlock.create({
      data: {
        accountId: student.id,
        blocksVideos: true,
        blocksDocuments: false,
        note: "Paused for review.",
        blockedById: admin.id,
      },
    });
    const video = await createFileAsset(student.id, "STORY_VIDEO", { contentType: "video/mp4" });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory({ videoFileId: video.id }),
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("UPLOADS_BLOCKED");
  });

  it("answers 403 to an admin", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(admin),
      payload: studentStory(),
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a fourth story with 409 STORY_LIMIT_REACHED", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    await createStoryRow(student.id, { status: "APPROVED" });
    await createStoryRow(student.id, { status: "REJECTED" });
    await createStoryRow(student.id, { status: "REJECTED" });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory(),
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("STORY_LIMIT_REACHED");
  });

  it("refuses a second story while one waits, with 409 STORY_PENDING", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    await createStoryRow(student.id, { status: "PENDING" });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory(),
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("STORY_PENDING");
  });

  it("lets a story go in again once the pending one is decided", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();
    const pending = await createStoryRow(student.id, { status: "PENDING" });
    await prisma.story.update({
      where: { id: pending.id },
      data: { status: "REJECTED", moderationNote: "Not a good fit.", decidedAt: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await headers(student),
      payload: studentStory(),
    });

    expect(res.statusCode).toBe(201);
  });

  it("the database refuses a second pending story for one account (partial unique index)", async () => {
    const student = await studentWithProfile();
    await createStoryRow(student.id, { status: "PENDING" });

    await expect(createStoryRow(student.id, { status: "PENDING" })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});

describe("DELETE /api/v1/me/stories/:id", () => {
  it("removes my story and its files (204), and answers 404 for another account's story", async () => {
    const app = await createTestApp();
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    const student = await studentWithProfile();
    const stranger = await studentWithProfile();
    const image = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    const story = await createStoryRow(student.id, { status: "PENDING", imageFileId: image.id });
    fake.put(image.storageKey, fakeFileBytes("image/png", 64), "image/png");

    const other = await app.inject({
      method: "DELETE",
      url: `${URL}/${story.id}`,
      headers: await headers(stranger),
    });
    expect(other.statusCode).toBe(404);

    const res = await app.inject({
      method: "DELETE",
      url: `${URL}/${story.id}`,
      headers: await headers(student),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.story.count({ where: { id: story.id } })).toBe(0);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: image.id } });
    expect(file.status).toBe("DELETED");
    expect(fake.objects.has(image.storageKey)).toBe(false);
    setStorageForTests(null);
  });

  it("answers 404 for a story that does not exist", async () => {
    const app = await createTestApp();
    const student = await studentWithProfile();

    const res = await app.inject({
      method: "DELETE",
      url: `${URL}/00000000-0000-4000-8000-000000000000`,
      headers: await headers(student),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("a story on the landing page", () => {
  async function landingWith(items: Json[]) {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const value = structuredClone((defaults as Json).testimonials);
    value.items = items;
    const res = await app.inject({
      method: "PUT",
      url: `${SITE_URL}/testimonials`,
      headers: await headers(admin),
      payload: { value, expectedUpdatedAt: null },
    });
    expect(res.statusCode).toBe(200);
    return { app, admin };
  }

  function card(storyId: string, photo = "/assets/testimonials/one.png") {
    return {
      name: "Ana",
      role: "Student",
      photo,
      quote: "Great help",
      comment: "Clear lessons every week",
      source: { kind: "story", id: storyId },
    };
  }

  it("reports onLanding and drops the card, its photo and the join row when deleted", async () => {
    const student = await studentWithProfile();
    const image = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    const story = await createStoryRow(student.id, { status: "APPROVED", imageFileId: image.id });
    const shipped = (defaults as Json).testimonials.items[0];
    const { app } = await landingWith([card(story.id, `file:${image.id}`), shipped]);

    const before = JSON.parse(
      (await app.inject({ method: "GET", url: URL, headers: await headers(student) })).body,
    );
    expect(before.stories[0].onLanding).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: `${URL}/${story.id}`,
      headers: await headers(student),
    });
    expect(res.statusCode).toBe(204);

    const row = await prisma.siteContent.findUniqueOrThrow({ where: { key: "testimonials" } });
    expect((row.value as Json).items).toHaveLength(1);
    expect((row.value as Json).items[0].name).toBe(shipped.name);
    const joins = await prisma.siteContentFile.findMany({ where: { key: "testimonials" } });
    expect(joins).toHaveLength(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "site_content.source_removed", entityId: "testimonials" },
    });
    expect(audit?.actorAccountId).toBe(student.id);
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: image.id } });
    expect(file.status).toBe("DELETED");
  });

  it("deletes the whole row when its last card goes, so the block shows its default", async () => {
    const student = await studentWithProfile();
    const story = await createStoryRow(student.id, { status: "APPROVED" });
    const { app } = await landingWith([card(story.id)]);

    await app.inject({
      method: "DELETE",
      url: `${URL}/${story.id}`,
      headers: await headers(student),
    });

    expect(await prisma.siteContent.count({ where: { key: "testimonials" } })).toBe(0);
    const site = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/v1/site-content" })).body,
    );
    expect(site.testimonials).toEqual((defaults as Json).testimonials);
  });
});
